import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractHtmlTitle,
  HttpBrowserDriver,
  inspectHtmlElement,
  MockBrowserDriver,
  PlaywrightBrowserDriver,
  scanHtmlForErrors,
} from "../src/tools/browser-driver.js";

describe("Browser Driver Utilities", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Reasonate Preview &amp; Demo</title>
      </head>
      <body>
        <div id="root" class="container main-app">
          <h1 id="headline">Welcome to ReasonateAI</h1>
          <button id="cta-btn" class="btn primary-btn" data-testid="get-started" type="submit">Get Started</button>
          <p class="description">Autonomous AI CTO platform</p>
        </div>
      </body>
    </html>
  `;

  it("extracts page title from HTML and decodes entities", () => {
    expect(extractHtmlTitle(sampleHtml)).toBe("Reasonate Preview & Demo");
    expect(extractHtmlTitle("<html><body>No Title</body></html>")).toBe("");
  });

  it("inspects DOM elements by ID, class, tag, and attribute selector", () => {
    // ID selector
    const idEl = inspectHtmlElement(sampleHtml, "#headline");
    expect(idEl).toBeDefined();
    expect(idEl?.exists).toBe(true);
    expect(idEl?.text).toBe("Welcome to ReasonateAI");

    // Class selector
    const classEl = inspectHtmlElement(sampleHtml, ".primary-btn");
    expect(classEl?.exists).toBe(true);
    expect(classEl?.count).toBe(1);

    // Tag selector
    const tagEl = inspectHtmlElement(sampleHtml, "button");
    expect(tagEl?.exists).toBe(true);
    expect(tagEl?.text).toBe("Get Started");

    // Attribute selector [data-testid="get-started"]
    const attrEl = inspectHtmlElement(
      sampleHtml,
      '[data-testid="get-started"]'
    );
    expect(attrEl?.exists).toBe(true);
    expect(attrEl?.attributes?.["data-testid"]).toBe("get-started");

    // Tag with attribute selector button[type="submit"]
    const tagAttrEl = inspectHtmlElement(sampleHtml, 'button[type="submit"]');
    expect(tagAttrEl?.exists).toBe(true);
    expect(tagAttrEl?.text).toBe("Get Started");

    // Tag with ID selector
    const tagIdEl = inspectHtmlElement(sampleHtml, "h1#headline");
    expect(tagIdEl?.exists).toBe(true);
    expect(tagIdEl?.text).toBe("Welcome to ReasonateAI");

    // Tag with class selector
    const tagClassEl = inspectHtmlElement(sampleHtml, "button.primary-btn");
    expect(tagClassEl?.exists).toBe(true);

    // Non-existent selector
    const missingEl = inspectHtmlElement(sampleHtml, "#non-existent");
    expect(missingEl?.exists).toBe(false);
  });

  it("scans HTML for crash banners without false positives on ordinary text", () => {
    const cleanErrors = scanHtmlForErrors(sampleHtml);
    expect(cleanErrors).toEqual([]);

    // Page text casually discussing 500 error shouldn't trigger fatal error
    const discussionHtml = `
      <div>
        <h1>Troubleshooting Guide</h1>
        <p>In this guide we explain what a 500 internal server error means in REST APIs.</p>
      </div>
    `;
    expect(scanHtmlForErrors(discussionHtml)).toEqual([]);

    // Actual crash HTML
    const crashHtml = `
      <div>
        <h1>500 Internal Server Error</h1>
        <div class="nextjs-portal">Unhandled Runtime Error</div>
        <pre>TypeError: Cannot read properties of null (reading 'map')</pre>
      </div>
    `;
    const foundErrors = scanHtmlForErrors(crashHtml);
    expect(foundErrors.length).toBeGreaterThan(0);
    expect(foundErrors.some((e) => e.includes("500"))).toBe(true);
    expect(foundErrors.some((e) => e.includes("Next.js"))).toBe(true);

    // Vite overlay
    const viteHtml = `<html><body><vite-error-overlay id="vite-error-overlay"></vite-error-overlay></body></html>`;
    expect(scanHtmlForErrors(viteHtml).some((e) => e.includes("Vite"))).toBe(
      true
    );
  });
});

describe("HttpBrowserDriver Integration with real HTTP server", () => {
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
            <head><title>Healthy App</title></head>
            <body>
              <h1 id="app-title">Application Loaded</h1>
              <div id="content" data-testid="main-content">Welcome to the healthy preview.</div>
            </body>
          </html>
        `);
      } else if (url.pathname === "/error-500") {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Error</title></head>
            <body><h1>500 Internal Server Error</h1></body>
          </html>
        `);
      } else if (url.pathname === "/crash-overlay") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Crash</title></head>
            <body>
              <div id="__next-error">Unhandled Runtime Error: TypeError: undefined is not a function</div>
            </body>
          </html>
        `);
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

  it("verifies healthy application page successfully", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      captureScreenshot: true,
      expectedTitle: "Healthy App",
      selector: '[data-testid="main-content"]',
      url: `http://127.0.0.1:${serverPort}/`,
    });

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.title).toBe("Healthy App");
    expect(result.element?.exists).toBe(true);
    expect(result.element?.text).toBe("Welcome to the healthy preview.");
    expect(result.consoleErrors).toHaveLength(0);
    expect(result.networkFailures).toHaveLength(0);
    expect(result.screenshotBase64).toBeTruthy();
  });

  it("fails verification when interactive action is attempted without dynamic engine", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      action: "click",
      selector: "#app-title",
      url: `http://127.0.0.1:${serverPort}/`,
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("Interactive action"))).toBe(
      true
    );
  });

  it("detects 500 server error as failed verification", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      url: `http://127.0.0.1:${serverPort}/error-500`,
    });

    expect(result.status).toBe("error");
    expect(result.passed).toBe(false);
    expect(result.httpStatus).toBe(500);
    expect(result.networkFailures.length).toBeGreaterThan(0);
  });

  it("detects unhandled runtime error overlay in DOM", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      failOnConsoleErrors: true,
      url: `http://127.0.0.1:${serverPort}/crash-overlay`,
    });

    expect(result.status).toBe("failed");
    expect(result.passed).toBe(false);
    expect(result.consoleErrors.length).toBeGreaterThan(0);
  });

  it("fails verification when expected selector is missing", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      selector: "#missing-element",
      url: `http://127.0.0.1:${serverPort}/`,
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("missing-element"))).toBe(true);
  });

  it("fails verification when expected title does not match", async () => {
    const driver = new HttpBrowserDriver();
    const result = await driver.navigateAndInspect({
      expectedTitle: "Unexpected Title",
      url: `http://127.0.0.1:${serverPort}/`,
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("Unexpected Title"))).toBe(
      true
    );
  });
});

describe("MockBrowserDriver & Playwright Fallback", () => {
  it("executes MockBrowserDriver with custom response", async () => {
    const mock = new MockBrowserDriver(async (req) => ({
      passed: true,
      status: "passed",
      summary: `Custom mock answer for ${req.url}`,
      title: "Custom Mock App",
    }));

    const res = await mock.navigateAndInspect({
      url: "http://127.0.0.1:3000/",
    });
    expect(res.passed).toBe(true);
    expect(res.title).toBe("Custom Mock App");
  });

  it("PlaywrightBrowserDriver falls back to HttpBrowserDriver cleanly when playwright is uninstalled", async () => {
    const driver = new PlaywrightBrowserDriver();
    const mockServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><head><title>Fallback Test</title></head><body><h1>OK</h1></body></html>"
      );
    });

    const port = await new Promise<number>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      const result = await driver.navigateAndInspect({
        url: `http://127.0.0.1:${port}/`,
      });
      expect(result.passed).toBe(true);
      expect(result.title).toBe("Fallback Test");
    } finally {
      mockServer.close();
    }
  });
});
