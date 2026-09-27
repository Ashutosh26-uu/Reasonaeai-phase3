import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import {
  readRunScope,
  runScopeKeys,
  sandboxIdFor,
} from "@reasonateai/cto-runtime/run-scope";
import {
  type CheckpointSandbox,
  type CheckpointStore,
  createGitCheckpointStore,
  restoreSandbox,
  snapshotSandbox,
} from "@reasonateai/sandbox/checkpoint";
import { reasonateBuildWorkspace } from "../mastra/workspace.js";

const execFileAsync = promisify(execFile);
const WORKDIR = "/workspace";

/** The message the failing store raises, asserted on the rejection it induces. */
const INDUCED_CHECKPOINT_FAILURE = /induced checkpoint failure/;

function contextFor(buildSessionId: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.setRaw(runScopeKeys.organizationId, randomUUID());
  requestContext.setRaw(runScopeKeys.projectId, randomUUID());
  requestContext.setRaw(runScopeKeys.buildSessionId, buildSessionId);
  requestContext.setRaw(runScopeKeys.runId, randomUUID());
  return requestContext;
}

function contractFor(sandbox: WorkspaceSandbox): CheckpointSandbox {
  const executeCommand = sandbox.executeCommand?.bind(sandbox);
  const writeFiles = sandbox.writeFiles?.bind(sandbox);
  return {
    runCommand: async (request) => {
      assert.ok(executeCommand, "sandbox exposes executeCommand");
      const result = await executeCommand(request.command, request.args, {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.timeoutMs === undefined
          ? {}
          : { timeout: request.timeoutMs }),
      });
      return {
        durationMs: result.executionTimeMs,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut ?? false,
      };
    },
    writeFile: async (relativePath, content) => {
      assert.ok(writeFiles, "sandbox exposes writeFiles");
      await writeFiles([{ content: Buffer.from(content), path: relativePath }]);
    },
  };
}

async function dockerLines(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim().split("\n").filter(Boolean);
}

async function containerCount(volume: string): Promise<number> {
  const lines = await dockerLines([
    "ps",
    "-a",
    "-q",
    "--filter",
    `volume=${volume}`,
  ]);
  return lines.length;
}

async function volumeCount(volume: string): Promise<number> {
  const lines = await dockerLines([
    "volume",
    "ls",
    "-q",
    "--filter",
    `name=^${volume}$`,
  ]);
  return lines.length;
}

async function startSandbox(context: RequestContext): Promise<{
  sandbox: WorkspaceSandbox;
  volume: string;
}> {
  const sandbox = await reasonateBuildWorkspace.resolveSandbox({
    requestContext: context,
  });
  assert.ok(sandbox, "the workspace resolved a sandbox");
  await sandbox.start?.();
  return {
    sandbox,
    volume: `${sandboxIdFor(readRunScope(context))}-workspace`,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-smoke-"));
  const store = createGitCheckpointStore({ root });

  // 1. Snapshot a real workspace while it still owns a container.
  const firstContext = contextFor(randomUUID());
  const first = await startSandbox(firstContext);
  const scope = readRunScope(firstContext);
  const firstContract = contractFor(first.sandbox);
  await firstContract.writeFile("hello.txt", "reasonate\n");
  await firstContract.writeFile("src/app.ts", "export const x = 1;\n");

  assert.equal(await containerCount(first.volume), 1, "container is up");
  assert.equal(await volumeCount(first.volume), 1, "volume was created");

  const written = await snapshotSandbox({
    buildSessionId: scope.buildSessionId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    runId: scope.runId,
    sandbox: firstContract,
    store,
    workdir: WORKDIR,
  });
  console.log("snapshot:", written.checkpointId, `${written.bytes} bytes`);

  // 2. Snapshot -> destroy -> volume removal, the order the CLI uses.
  await first.sandbox.destroy?.();
  await execFileAsync("docker", ["volume", "rm", "-f", first.volume]);
  assert.equal(await containerCount(first.volume), 0, "container is gone");
  assert.equal(await volumeCount(first.volume), 0, "volume is gone");
  console.log("after a successful checkpoint: no container, no volume");

  // 3. Restore into a freshly created sandbox and read the work back.
  const second = await startSandbox(contextFor(randomUUID()));
  const secondContract = contractFor(second.sandbox);
  await restoreSandbox({
    checkpointId: written.checkpointId,
    sandbox: secondContract,
    store,
    workdir: WORKDIR,
  });
  const read = await secondContract.runCommand({
    args: ["-c", "cat hello.txt && cat src/app.ts && git log --oneline"],
    command: "sh",
    cwd: WORKDIR,
  });
  assert.equal(read.exitCode, 0, read.stderr);
  const restoredText = read.stdout.replaceAll("\r\n", "\n");
  assert.ok(restoredText.includes("reasonate\n"), restoredText);
  assert.ok(restoredText.includes("export const x = 1;\n"), restoredText);
  assert.ok(
    restoredText.includes("ReasonateAI workspace checkpoint"),
    restoredText
  );
  console.log("restored stdout:", JSON.stringify(restoredText));

  await second.sandbox.destroy?.();
  await execFileAsync("docker", ["volume", "rm", "-f", second.volume]);
  assert.equal(await containerCount(second.volume), 0);
  assert.equal(await volumeCount(second.volume), 0);
  console.log("after the restore sandbox teardown: no container, no volume");

  // 4. A failed checkpoint drops the container but keeps the volume.
  const third = await startSandbox(contextFor(randomUUID()));
  const failingStore: CheckpointStore = {
    ...store,
    write: () => Promise.reject(new Error("induced checkpoint failure")),
  };
  await assert.rejects(
    snapshotSandbox({
      buildSessionId: scope.buildSessionId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId: scope.runId,
      sandbox: contractFor(third.sandbox),
      store: failingStore,
      workdir: WORKDIR,
    }),
    INDUCED_CHECKPOINT_FAILURE
  );

  await third.sandbox.destroy?.();
  assert.equal(
    await containerCount(third.volume),
    0,
    "container is gone after a failed checkpoint"
  );
  assert.equal(
    await volumeCount(third.volume),
    1,
    "volume is retained after a failed checkpoint"
  );
  console.log("after a failed checkpoint: container gone, volume retained");

  await execFileAsync("docker", ["volume", "rm", "-f", third.volume]);
  await rm(root, { force: true, recursive: true });
  console.log("SMOKE_OK");
}

await main();
