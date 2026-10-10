import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { SandboxIdSchema } from "@reasonateai/contracts/sandbox";
import { DockerSandboxProvider } from "@reasonateai/sandbox/docker";
import { afterAll, describe, expect, it } from "vitest";
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
        .poll(async () => (await service.status(view.previewId))?.view.status, {
          // Two bounded HTTP probes and Docker teardown exceed the default poll window.
          timeout: 15_000,
        })
        .toBe("failed");
    });
  }
);
