import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import {
  BuildSessionIdSchema,
  PreviewIdSchema,
} from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { SandboxIdSchema } from "@reasonateai/contracts/sandbox";
import { createInMemoryPreviewRepository } from "@reasonateai/project-state/previews";
import { DockerSandboxProvider } from "@reasonateai/sandbox/docker";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  connectPreviewApp,
  discoverPreviewApp,
} from "../src/mastra/preview-port.js";
import { createPreviewService } from "../src/mastra/preview-service.js";

const execFileAsync = promisify(execFile);
const dockerAvailable = await execFileAsync("docker", ["info"]).then(
  () => true,
  () => false
);

describe.skipIf(!dockerAvailable)(
  "live preview app ports",
  { timeout: 360_000 },
  () => {
    const provider = new DockerSandboxProvider();
    const services: ReturnType<typeof createPreviewService>[] = [];
    const scope = {
      organizationId: OrganizationIdSchema.parse(randomUUID()),
      projectId: ProjectIdSchema.parse(randomUUID()),
    };

    afterAll(async () => {
      await Promise.all(services.map((service) => service.disposeAll()));
      await provider.destroyAll();
    }, 30_000);

    const sandbox = () =>
      provider.create({
        id: SandboxIdSchema.parse(`test-title-menu-${randomUUID()}`),
        image: "node:22",
        networkMode: "bridge",
        ports: [3000, 18_080],
        projectId: scope.projectId,
        runId: null,
      });

    it("attaches after turn completion and retries routing failure without destroying the app", async () => {
      const app = await sandbox();
      await app.writeFile(
        "app.cjs",
        "require('node:http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('Survives completed turn')}).listen(5179,'127.0.0.1');"
      );
      await app.writeFile(
        ".reasonate/preview.json",
        JSON.stringify({ host: "127.0.0.1", port: 5179 })
      );
      await app.runCommand({
        args: ["-c", "nohup node app.cjs >/tmp/app.log 2>&1 </dev/null &"],
        command: "sh",
      });
      await expect
        .poll(() => discoverPreviewApp(app, 5179))
        .toMatchObject({ port: 5179 });
      const store = createInMemoryPreviewRepository();
      const request = {
        ...scope,
        buildSessionId: BuildSessionIdSchema.parse(randomUUID()),
        runId: RunIdSchema.parse(randomUUID()),
      };
      const lease = await store.record({
        ...request,
        containerName: `reasonate-sbx-${app.id}`,
        previewId: PreviewIdSchema.parse(randomUUID()),
        sandboxId: app.id,
        status: "starting",
      });
      const service = createPreviewService({
        attachRunSandbox: () => Promise.resolve(app),
        isRunActive: () => Promise.resolve(false),
        previewStore: store,
      });
      services.push(service);
      const opened = await service.start(request);
      expect(opened.previewId).toBe(lease.previewId);
      await expect
        .poll(
          async () => (await service.status(opened.previewId))?.view.status,
          { timeout: 15_000 }
        )
        .toBe("ready");
      const target = await service.target(opened.previewId);
      expect(
        await (await fetch(`http://127.0.0.1:${target?.hostPort}/`)).text()
      ).toContain("Survives completed turn");
      const failedProbe = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("temporary relay failure"));
      try {
        expect((await service.status(opened.previewId))?.view.status).toBe(
          "failed"
        );
      } finally {
        failedProbe.mockRestore();
      }
      expect((await app.getState()).status).toBe("running");
      const retried = await service.start(request);
      await expect
        .poll(
          async () => (await service.status(retried.previewId))?.view.status,
          { timeout: 15_000 }
        )
        .toBe("ready");
      const retriedTarget = await service.target(retried.previewId);
      expect(
        await (
          await fetch(`http://127.0.0.1:${retriedTarget?.hostPort}/`)
        ).text()
      ).toContain("Survives completed turn");
    });

    it("prefers the HTML app over a JSON server and honors an agent-selected port", async () => {
      const app = await sandbox();
      await app.writeFile(
        "servers.cjs",
        `const http=require('node:http'); for(const [port,type] of [[4000,'application/json'],[5173,'text/html']]) http.createServer((_,res)=>{res.setHeader('content-type',type);res.end(type)}).listen(port,'127.0.0.1');`
      );
      await app.runCommand({
        args: ["-c", "nohup node servers.cjs >/tmp/app.log 2>&1 </dev/null &"],
        command: "sh",
      });
      await expect
        .poll(() => discoverPreviewApp(app), { timeout: 10_000 })
        .toMatchObject({ port: 5173 });
      expect(await discoverPreviewApp(app, 4000)).toMatchObject({ port: 4000 });
      expect(await discoverPreviewApp(app, 5555)).toBeUndefined();
      await connectPreviewApp(app, { host: "127.0.0.1", port: 5173 }, 3000);
      const hostPort = await app.exposePort?.(3000);
      await expect
        .poll(async () => (await fetch(`http://127.0.0.1:${hostPort}/`)).text())
        .toBe("text/html");
      await connectPreviewApp(app, { host: "127.0.0.1", port: 5173 }, 3000);
      await expect
        .poll(async () => (await fetch(`http://127.0.0.1:${hostPort}/`)).text())
        .toBe("text/html");
      await app.runCommand({
        args: ["-f", "node servers.cjs"],
        command: "pkill",
      });
      await expect
        .poll(async () =>
          (await fetch(`http://127.0.0.1:${hostPort}/`)).headers.get(
            "x-reasonate-preview-upstream"
          )
        )
        .toBe("unavailable");
    });

    it("previews the selected running app in its run sandbox", async () => {
      const app = await sandbox();
      await app.writeFile(
        "app.cjs",
        `const http=require('node:http');http.createServer((req,res)=>{if(req.url.endsWith('/main.js')){res.setHeader('content-type','text/javascript');res.end('window.previewLoaded = true');return}res.setHeader('content-type','text/html');res.end('<script src="/main.js"></script><main>Vite app loaded</main>')}).listen(5177,'127.0.0.1');`
      );
      await app.writeFile(
        ".reasonate/preview.json",
        JSON.stringify({ host: "127.0.0.1", port: 5177 })
      );
      const buildSessionId = BuildSessionIdSchema.parse(randomUUID());
      const runId = RunIdSchema.parse(randomUUID());
      await app.runCommand({
        args: ["-c", "nohup node app.cjs >/tmp/app.log 2>&1 </dev/null &"],
        command: "sh",
      });
      const service = createPreviewService({
        attachRunSandbox: async () => app,
        isRunActive: async () => false,
      });
      services.push(service);
      const view = await service.start({
        ...scope,
        buildSessionId,
        runId,
      });
      await expect
        .poll(async () => (await service.status(view.previewId))?.view.status, {
          interval: 1000,
          timeout: 320_000,
        })
        .toBe("ready");
      const readyView = await service.status(view.previewId);
      expect(readyView?.view.port).toBe(5177);
      const target = await service.target(view.previewId);
      expect(target?.hostPort).not.toBe(5177);
      const base = `http://127.0.0.1:${target?.hostPort}`;
      const page = await fetch(base);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("main.js");
      expect(html).toContain("Vite app loaded");
      const script = await fetch(`${base}/main.js`);
      expect(script.headers.get("content-type")).toContain("javascript");
      expect(await script.text()).toContain("window.previewLoaded = true");
      await app.runCommand({
        args: ["-f", "node app.cjs"],
        command: "pkill",
      });
      await expect
        .poll(async () => (await service.status(view.previewId))?.view.status)
        .toBe("failed");
    });

    it("tunnels WebSocket upgrades through the selected relay port", async () => {
      const app = await sandbox();
      await app.writeFile(
        "ws-server.cjs",
        `const http=require('node:http');const crypto=require('node:crypto');const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('WebSocket app')});server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\nX-App-Path: '+req.url+'\\r\\nX-App-Cookie: '+(req.headers.cookie?'present':'missing')+'\\r\\nX-App-Authorization: '+(req.headers.authorization?'present':'missing')+'\\r\\n\\r\\n')});server.listen(5178,'127.0.0.1');`
      );
      await app.runCommand({
        args: [
          "-c",
          "nohup node ws-server.cjs >/tmp/ws-app.log 2>&1 </dev/null &",
        ],
        command: "sh",
      });
      await expect
        .poll(() => discoverPreviewApp(app, 5178), { timeout: 10_000 })
        .toMatchObject({ port: 5178 });

      const previewId = randomUUID();
      await connectPreviewApp(
        app,
        { host: "127.0.0.1", port: 5178 },
        3000,
        `/v1/previews/${previewId}/`
      );
      const hostPort = await app.exposePort?.(3000);
      if (hostPort === undefined) {
        throw new Error("The test sandbox did not expose its preview relay.");
      }

      const socket = await openSocket(hostPort);
      try {
        const responseHeaders = readSocketHeaders(socket);
        socket.write(
          [
            "GET /socket?hmr=1 HTTP/1.1",
            `Host: 127.0.0.1:${hostPort}`,
            `Origin: http://127.0.0.1:${hostPort}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            "Cookie: reasonate_session=must-not-reach-app",
            "Authorization: Bearer must-not-reach-app",
            "",
            "",
          ].join("\r\n")
        );
        const headers = await responseHeaders;
        expect(headers).toContain("HTTP/1.1 101 Switching Protocols");
        expect(headers).toContain(
          `X-App-Path: /v1/previews/${previewId}/socket?hmr=1`
        );
        expect(headers).toContain("X-App-Cookie: missing");
        expect(headers).toContain("X-App-Authorization: missing");
      } finally {
        socket.destroy();
      }
    });
  }
);

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readSocketHeaders(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error("The preview relay did not complete the WebSocket handshake.")
      );
    }, 5000);
    const onData = (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        cleanup();
        resolve(response);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}
