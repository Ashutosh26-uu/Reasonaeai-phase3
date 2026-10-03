import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DockerSandbox } from "@mastra/docker";
import { createWorkspaceEditTool } from "@reasonateai/cto-runtime/tools/edit";
import { ReadSnapshotStore } from "@reasonateai/cto-runtime/tools/read-snapshots";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxFilesystem } from "../src/sandbox-filesystem.js";

const execFileAsync = promisify(execFile);

const dockerAvailable = await execFileAsync("docker", ["info"]).then(
  () => true,
  () => false
);

const describeWithDocker = dockerAvailable ? describe : describe.skip;

describeWithDocker("Docker sandbox edit tool integration", () => {
  const sandboxId = `test-edit-${randomUUID()}`;
  const volumeName = `${sandboxId}-workspace`;

  let sandbox: DockerSandbox;
  let filesystem: SandboxFilesystem;

  beforeAll(async () => {
    sandbox = new DockerSandbox({
      capDrop: ["ALL"],
      env: { HOME: "/workspace" },
      id: sandboxId,
      image: "node:22",
      mounts: [
        {
          source: volumeName,
          target: "/workspace",
          type: "volume",
        },
      ],
      network: "none",
      pidsLimit: 256,
      securityOpt: ["no-new-privileges:true"],
      timeout: 30_000,
      workingDirectory: "/workspace",
    });

    await sandbox.start();

    filesystem = new SandboxFilesystem({
      id: `${sandboxId}-filesystem`,
      root: "/workspace",
      sandbox,
    });
  }, 45_000);

  afterAll(async () => {
    if (sandbox) {
      await sandbox.destroy().catch(() => undefined);
    }
    await execFileAsync("docker", ["volume", "rm", "-f", volumeName]).catch(
      () => undefined
    );
  });

  it("edits files inside live Docker container across all path representations", async () => {
    // 1. Seed initial source files into container workspace
    await filesystem.writeFile("src/index.ts", 'console.log("INITIAL_V1");\n', {
      recursive: true,
    });
    await filesystem.writeFile(
      "src/math.ts",
      "export const multiplier = 10;\n",
      { recursive: true }
    );

    const snapshots = new ReadSnapshotStore();
    const editTool = createWorkspaceEditTool({
      resolveFilesystem: async () => filesystem,
      resolveSnapshots: async () => snapshots,
      root: "/workspace",
    });

    const runEdit = (
      args: Parameters<NonNullable<(typeof editTool)["execute"]>>[0]
    ) => {
      const { execute } = editTool;
      if (!execute) {
        throw new Error("editTool.execute is undefined");
      }
      return execute(args, { requestContext: {} } as never);
    };

    const runCommand = (
      cmd: string,
      args: string[],
      options?: { cwd?: string }
    ) => {
      const { executeCommand } = sandbox;
      if (!executeCommand) {
        throw new Error("sandbox.executeCommand is undefined");
      }
      return executeCommand.call(sandbox, cmd, args, options);
    };

    // 2. Edit using relative path: "src/index.ts"
    const res1 = await runEdit({
      newString: 'console.log("EDIT_RELATIVE");\n',
      oldString: 'console.log("INITIAL_V1");\n',
      path: "src/index.ts",
    });
    expect(res1).toContain('+console.log("EDIT_RELATIVE");');

    // 3. Edit using leading slash path: "/src/index.ts"
    const res2 = await runEdit({
      newString: 'console.log("EDIT_ROOT_RELATIVE");\n',
      oldString: 'console.log("EDIT_RELATIVE");\n',
      path: "/src/index.ts",
    });
    expect(res2).toContain('+console.log("EDIT_ROOT_RELATIVE");');

    // 4. Edit using full container workspace path: "/workspace/src/index.ts"
    const res3 = await runEdit({
      newString: 'console.log("EDIT_FULL_WORKSPACE");\n',
      oldString: 'console.log("EDIT_ROOT_RELATIVE");\n',
      path: "/workspace/src/index.ts",
    });
    expect(res3).toContain('+console.log("EDIT_FULL_WORKSPACE");');

    // 5. Edit using Windows backslash relative path: "src\\index.ts"
    const res4 = await runEdit({
      newString: 'console.log("EDIT_WIN_BACKSLASH");\n',
      oldString: 'console.log("EDIT_FULL_WORKSPACE");\n',
      path: "src\\index.ts",
    });
    expect(res4).toContain('+console.log("EDIT_WIN_BACKSLASH");');

    // 6. Edit using Windows drive letter with workspace: "C:\\workspace\\src\\index.ts"
    const res5 = await runEdit({
      newString: 'console.log("EDIT_WIN_DRIVE_WORKSPACE");\n',
      oldString: 'console.log("EDIT_WIN_BACKSLASH");\n',
      path: "C:\\workspace\\src\\index.ts",
    });
    expect(res5).toContain('+console.log("EDIT_WIN_DRIVE_WORKSPACE");');

    // 7. Edit using Windows drive letter root-relative: "C:\\src\\index.ts"
    const res6 = await runEdit({
      newString: 'console.log("EDIT_WIN_DRIVE_ROOT");\n',
      oldString: 'console.log("EDIT_WIN_DRIVE_WORKSPACE");\n',
      path: "C:\\src\\index.ts",
    });
    expect(res6).toContain('+console.log("EDIT_WIN_DRIVE_ROOT");');

    // 8. Edit using file:// URL: "file:///workspace/src/math.ts"
    const res7 = await runEdit({
      newString: "export const multiplier = 20;\n",
      oldString: "export const multiplier = 10;\n",
      path: "file:///workspace/src/math.ts",
    });
    expect(res7).toContain("+export const multiplier = 20;");

    // 9. Edit using hashline patch format with snapshot anchor
    const mathContent = String(
      await filesystem.readFile("src/math.ts", { encoding: "utf8" })
    );
    const mathTag = await snapshots.record(
      "/workspace/src/math.ts",
      mathContent,
      [1]
    );
    const patchBody = `[src/math.ts#${mathTag}]\nSWAP 1.=1:\n+export const multiplier = 50;\n`;
    const res8 = await runEdit({
      patch: patchBody,
    });
    expect(res8).toContain("update");

    // 10. Verify both edited files by executing node commands directly inside the Docker container
    const execResult = await runCommand(
      "node",
      ["-e", 'require("./src/index.ts");'],
      { cwd: "/workspace" }
    );
    expect(execResult.success).toBe(true);
    expect(execResult.stdout.trim()).toBe("EDIT_WIN_DRIVE_ROOT");

    const execResultMath = await runCommand(
      "node",
      ["-e", 'console.log(require("./src/math.ts").multiplier);'],
      { cwd: "/workspace" }
    );
    expect(execResultMath.success).toBe(true);
    expect(execResultMath.stdout.trim()).toBe("50");

    // 11. Verify traversal attempts fail without modifying files
    await expect(
      runEdit({
        newString: "hacked",
        oldString: "root",
        path: "../../etc/passwd",
      })
    ).rejects.toThrow("escapes the verified workspace");
  }, 60_000);
});
