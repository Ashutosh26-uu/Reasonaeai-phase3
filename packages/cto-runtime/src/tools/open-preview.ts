import { posix } from "node:path";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import {
  AppPreviewConfigurationSchema,
  OpenAppPreviewRequestSchema,
  OpenAppPreviewResultSchema,
} from "@reasonateai/contracts/execution";
import type { RunScope } from "../run-scope.js";
import { readRunScope } from "../run-scope.js";
import { splitLines } from "./read.js";
import { WorkspaceHashlineFilesystem } from "./workspace-filesystem.js";
import { type WorkspaceWriteToolOptions, writeFileWithHash } from "./write.js";

async function probeApp(sandbox: WorkspaceSandbox, url: URL) {
  if (!sandbox.executeCommand) {
    throw new Error("The verified sandbox cannot check the selected app.");
  }
  const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
  const target = `http://${host}:${url.port}${url.pathname}`;
  const result = await sandbox.executeCommand(
    "node",
    [
      "-e",
      `
const http = require('node:http');
http.get(${JSON.stringify(target)}, {signal:AbortSignal.timeout(2000)}, response => {
  const address = response.socket.remoteAddress;
  const selected = address === '::ffff:127.0.0.1' ? '127.0.0.1' : address;
  const status = response.statusCode || 0;
  response.destroy();
  if (status >= 200 && status < 400 && (selected === '127.0.0.1' || selected === '::1')) {
    process.stdout.write(JSON.stringify(selected));
  } else process.exitCode = 1;
}).on('error', () => process.exitCode = 1);
`,
    ],
    { timeout: 3000 }
  );
  if (result.exitCode !== 0 || result.timedOut || result.killed) {
    throw new Error(
      "The selected app URL is not responding successfully inside this run's sandbox. Start the intended server and retry open_preview."
    );
  }
  try {
    return AppPreviewConfigurationSchema.shape.host
      .unwrap()
      .parse(JSON.parse(result.stdout));
  } catch (cause) {
    throw new Error(
      "The selected app's loopback address could not be verified.",
      {
        cause,
      }
    );
  }
}

async function configureApp(
  input: WorkspaceWriteToolOptions,
  requestContext: RequestContext,
  port: number,
  script: string | undefined,
  host: "127.0.0.1" | "::1"
) {
  const root = posix.normalize(input.root ?? "/workspace");
  const workspaceFilesystem = await input.resolveFilesystem(requestContext);
  const filesystem = new WorkspaceHashlineFilesystem({
    filesystem: workspaceFilesystem,
    root,
  });
  const snapshots = await input.resolveSnapshots(requestContext);
  const path = filesystem.canonicalPath(".reasonate/preview.json");
  let configuration = AppPreviewConfigurationSchema.parse({});
  let expectedHash: string | undefined;
  if (await filesystem.exists(path)) {
    const metadata = await workspaceFilesystem.stat(path);
    if (metadata.type !== "file" || metadata.size > 8192) {
      throw new Error(
        "The preview manifest must be a JSON file of at most 8 KB."
      );
    }
    const previous = await filesystem.readText(path);
    if (Buffer.byteLength(previous, "utf8") > 8192) {
      throw new Error(
        "The preview manifest exceeds 8 KB. Reduce it before opening the app."
      );
    }
    try {
      configuration = AppPreviewConfigurationSchema.parse(JSON.parse(previous));
    } catch (cause) {
      throw new Error(
        "The preview manifest is invalid. Use only host, port, and script with their documented values, then retry open_preview.",
        { cause }
      );
    }
    expectedHash = await snapshots.record(
      path,
      previous,
      splitLines(previous).map((_, index) => index + 1)
    );
    if (!expectedHash) {
      throw new Error("The preview manifest could not be read safely.");
    }
  }
  const selected = AppPreviewConfigurationSchema.parse({
    ...configuration,
    host,
    port,
    ...(script === undefined ? {} : { script }),
  });
  await writeFileWithHash(
    {
      content: `${JSON.stringify(selected, null, 2)}\n`,
      expectedHash,
      path,
    },
    { filesystem, root, snapshots }
  );
}

export function createOpenPreviewTool(
  input: WorkspaceWriteToolOptions & {
    registerPreview?: (
      selection: RunScope & { appPort: number }
    ) => Promise<void>;
    resolveSandbox: (
      requestContext: RequestContext
    ) => Promise<WorkspaceSandbox>;
  }
) {
  return createTool({
    description:
      "Start the intended web app inside this run's sandbox, then select its exact HTTP localhost URL with an explicit port (1024–65535 except reserved 18080) and optional route. Verify that exact listener and save the selected host/port in .reasonate/preview.json. The App preview attaches to this same sandbox immediately; it does not wait for a checkpoint, launch another container, or select a different port on failure. A successful request is not readiness or browser verification. URLs cannot contain credentials, queries, or fragments. After selecting the app, use browser_verify on this localhost URL or its sandbox-private address; the tool routes only this run's selected app or relay port through its preview gateway. External URLs and interactive browser-use sessions require separate tools.",
    execute: async ({ url, script }, context) => {
      const scope = readRunScope(context.requestContext);
      context.abortSignal?.throwIfAborted();
      const target = new URL(url);
      const host = await probeApp(
        await input.resolveSandbox(context.requestContext),
        target
      );
      context.abortSignal?.throwIfAborted();
      await configureApp(
        input,
        context.requestContext,
        Number(target.port),
        script,
        host
      );
      await input.registerPreview?.({ ...scope, appPort: Number(target.port) });
      context.abortSignal?.throwIfAborted();
      return OpenAppPreviewResultSchema.parse({
        buildSessionId: scope.buildSessionId,
        host,
        kind: "app-preview",
        path: target.pathname,
        port: Number(target.port),
        runId: scope.runId,
        schemaVersion: 1,
        status: "requested",
      });
    },
    id: "open_preview",
    inputSchema: OpenAppPreviewRequestSchema,
    outputSchema: OpenAppPreviewResultSchema,
  });
}
