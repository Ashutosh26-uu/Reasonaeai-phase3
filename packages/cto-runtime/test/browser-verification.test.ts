import { createServer, type Server } from "node:http";
import { RequestContext } from "@mastra/core/request-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReasonateCtoRuntime } from "../src/runtime.js";
import { MockBrowserDriver } from "../src/tools/browser-driver.js";
import { createBrowserVerificationTool } from "../src/tools/browser-verification.js";

const METADATA_PATTERN = /metadata/i;
const RESTRICTED_PATTERN = /restricted/i;
const PROTOCOL_RELATIVE_PATTERN = /Protocol-relative URLs are forbidden/i;

describe("createBrowserVerificationTool", () => {
  let server: Server;
  let serverPort: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Preview Demo</title></head>
            <body>
              <div id="app">
                <h1 id="header">Reasonate Preview</h1>
                <p id="status-text">Application running successfully</p>
              </div>
            </body>
          </html>
        `);
      } else if (url.pathname === "/failing-route") {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("500 Internal Server Error: Database unreachable");
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          serverPort = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function executeTool(
    tool: ReturnType<typeof createBrowserVerificationTool>,
    input: {
      action?:
        | "click"
        | "fill"
        | "navigate"
        | "screenshot"
        | "inspect_dom"
        | "evaluate"
        | "verify"
        | undefined;
      captureConsole?: boolean | undefined;
      captureDom?: boolean | undefined;
      captureScreenshot?: boolean | undefined;
      evaluateScript?: string | undefined;
      expectedText?: string | undefined;
      expectedTitle?: string | undefined;
      failOnConsoleErrors?: boolean | undefined;
      failOnNetworkErrors?: boolean | undefined;
      fillValue?: string | undefined;
      previewId?: string | undefined;
      selector?: string | undefined;
      timeoutMs?: number | undefined;
      url: string;
      waitForSelector?: string | undefined;
    }
  ) {
    const fn = tool.execute;
    if (!fn) {
      throw new Error("tool.execute is undefined");
    }
    const context = {
      requestContext: new RequestContext(),
    };
    return (await fn(input, context as never)) as {
      consoleErrors: { level: string; text: string; timestamp: string }[];
      element?: { exists: boolean; text?: string | undefined };
      httpStatus: number;
      networkFailures: unknown[];
      passed: boolean;
      screenshotBase64?: string | null;
      status: string;
      summary: string;
      title: string;
      url: string;
    };
  }

  it("creates a tool with id 'browser_verify'", () => {
    const tool = createBrowserVerificationTool();
    expect(tool.id).toBe("browser_verify");
    expect(tool.description).toContain("headless browser");
  });

  it("verifies live preview page successfully", async () => {
    const tool = createBrowserVerificationTool();
    const result = await executeTool(tool, {
      expectedTitle: "Preview Demo",
      selector: "#header",
      url: `http://127.0.0.1:${serverPort}/`,
    });

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.title).toBe("Preview Demo");
    expect(result.element?.exists).toBe(true);
    expect(result.element?.text).toBe("Reasonate Preview");
    expect(result.consoleErrors).toHaveLength(0);
    expect(result.networkFailures).toHaveLength(0);
    expect(result.screenshotBase64).toBeTruthy();
    expect(result.summary).toContain("Browser verification passed");
  });

  it("resolves relative path using previewBaseUrl", async () => {
    const tool = createBrowserVerificationTool({
      previewBaseUrl: `http://127.0.0.1:${serverPort}`,
    });
    const result = await executeTool(tool, {
      expectedTitle: "Preview Demo",
      url: "/",
    });

    expect(result.passed).toBe(true);
    expect(result.url).toBe(`http://127.0.0.1:${serverPort}/`);
  });

  it("scopes relative path with previewId when provided", async () => {
    const tool = createBrowserVerificationTool({
      previewBaseUrl: `http://127.0.0.1:${serverPort}`,
    });
    const result = await executeTool(tool, {
      previewId: "123e4567-e89b-12d3-a456-426614174000",
      url: "/dashboard",
    });

    expect(result.url).toBe(
      `http://127.0.0.1:${serverPort}/v1/previews/123e4567-e89b-12d3-a456-426614174000/dashboard`
    );
  });

  it("fails verification on server error route", async () => {
    const tool = createBrowserVerificationTool();
    const result = await executeTool(tool, {
      url: `http://127.0.0.1:${serverPort}/failing-route`,
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe("error");
    expect(result.httpStatus).toBe(500);
    expect(result.summary).toContain("Browser verification error");
  });

  it("strictly defends against SSRF, cloud metadata, forbidden ports, and protocol-relative URLs", async () => {
    const tool = createBrowserVerificationTool({
      previewBaseUrl: `http://127.0.0.1:${serverPort}`,
    });
    // Cloud metadata
    await expect(
      executeTool(tool, {
        url: "http://169.254.169.254/latest/meta-data/",
      })
    ).rejects.toThrow(METADATA_PATTERN);

    // Forbidden Redis port
    await expect(
      executeTool(tool, {
        url: "http://127.0.0.1:6379/",
      })
    ).rejects.toThrow(RESTRICTED_PATTERN);

    // Protocol-relative bypass attempt
    await expect(
      executeTool(tool, {
        url: "//evil.com/hacked",
      })
    ).rejects.toThrow(PROTOCOL_RELATIVE_PATTERN);
  });

  it("supports MockBrowserDriver injection for unit testing", async () => {
    const mockDriver = new MockBrowserDriver(async (req) => ({
      passed: true,
      status: "passed",
      summary: `Verified mock route ${req.url}`,
      title: "Injected Mock Title",
    }));

    const tool = createBrowserVerificationTool({ driver: mockDriver });
    const result = await executeTool(tool, {
      url: "http://127.0.0.1:3000/mock",
    });

    expect(result.passed).toBe(true);
    expect(result.title).toBe("Injected Mock Title");
    expect(result.summary).toContain("Verified mock route");
  });
});

describe("Browser Verification Tool wiring in Reasonate CTO Runtime", () => {
  it("registers browser_verify in CTO runtime and delegatable subagents", async () => {
    const mockFs = {
      appendFile: () => Promise.resolve(),
      copyFile: () => Promise.resolve(),
      deleteFile: () => Promise.resolve(),
      exists: () => Promise.resolve(false),
      getStats: () =>
        Promise.resolve({ isDirectory: false, isFile: true, size: 0 }),
      mkdir: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      readFile: () => Promise.resolve(""),
      unlink: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
    };

    const mockWorkspace = {
      resolveFilesystem: () => Promise.resolve(mockFs),
      resolveSandbox: () => Promise.resolve({}),
    };

    const runtime = createReasonateCtoRuntime({
      enableBrowserVerification: true,
      model: "test/model",
      workspace: mockWorkspace as any,
    });

    // Main CTO Agent has browser_verify tool
    expect(runtime.browserVerificationTool).toBeDefined();
    expect(runtime.browserVerificationTool?.id).toBe("browser_verify");

    // Main agent tools include browser_verify
    const mainTools = await runtime.mainAgent.listTools();
    expect(mainTools.browser_verify).toBeDefined();

    // Check subagents
    const scout = runtime.subagents.find((s) => s.id === "scout");
    expect(scout).toBeDefined();
    expect(scout?.tools?.browser_verify).toBeDefined();

    const reviewer = runtime.subagents.find((s) => s.id === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.tools?.browser_verify).toBeDefined();

    const coder = runtime.subagents.find((s) => s.id === "coder");
    expect(coder).toBeDefined();
    expect(coder?.tools?.browser_verify).toBeDefined();

    const debuggerAgent = runtime.subagents.find((s) => s.id === "debugger");
    expect(debuggerAgent).toBeDefined();
    expect(debuggerAgent?.tools?.browser_verify).toBeDefined();
  });
});
