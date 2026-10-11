import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  WorkspaceFileSchema,
  WorkspaceTreeSchema,
} from "@reasonateai/contracts/execution-protocol";
import { DockerSandboxProvider } from "@reasonateai/sandbox/docker";
import { MastraWorkspaceSandboxAdapter } from "@reasonateai/sandbox/mastra";
import { afterAll, describe, expect, it } from "vitest";
import { readLiveWorkspace } from "../src/mastra/live-workspace";

const dockerAvailable = await promisify(execFile)("docker", ["info"]).then(
  () => true,
  () => false
);
describe.skipIf(!dockerAvailable)(
  "live sandbox source and shell",
  { timeout: 60_000 },
  () => {
    const provider = new DockerSandboxProvider();
    afterAll(() => provider.destroyAll());
    it("reads uncommitted creation/edit/deletion and executes multiline shell programs", async () => {
      const sandbox = await provider.create({
        id: `live-source-${randomUUID()}`,
        image: "node:22",
        networkMode: "bridge",
        projectId: randomUUID(),
        runId: null,
      });
      const adapter = new MastraWorkspaceSandboxAdapter({ sandbox });
      await adapter.start();
      const result = await adapter.executeCommand(
        "mkdir -p src\ncat > 'src/live file.txt' <<'EOF'\nfirst revision\nEOF\ncat 'src/live file.txt' | tr a-z A-Z"
      );
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("FIRST REVISION\n");
      const tree = WorkspaceTreeSchema.parse(await readLiveWorkspace(sandbox));
      expect(tree.source).toBe("live");
      expect(tree.checkpointId).toBe("");
      expect(
        tree.files.some((entry) => entry.path === "src/live file.txt")
      ).toBe(true);
      expect(
        WorkspaceFileSchema.parse(
          await readLiveWorkspace(sandbox, "src/live file.txt")
        ).text
      ).toBe("first revision\n");
      await adapter.executeCommand(
        "printf 'second revision' > 'src/live file.txt'"
      );
      expect(
        WorkspaceFileSchema.parse(
          await readLiveWorkspace(sandbox, "src/live file.txt")
        ).text
      ).toBe("second revision");
      await adapter.executeCommand("rm 'src/live file.txt'");
      expect(
        WorkspaceTreeSchema.parse(await readLiveWorkspace(sandbox)).files.some(
          (entry) => entry.path === "src/live file.txt"
        )
      ).toBe(false);
      const literal = await adapter.executeCommand("printf", [
        "%s",
        "a; echo unexpected",
      ]);
      expect(literal.stdout).toBe("a; echo unexpected");
      expect(
        (await adapter.executeCommand("printf failure >&2\nexit 7")).exitCode
      ).toBe(7);
    });

    it("rejects traversal, symlinks, metadata and bounds text and listing reads", async () => {
      const sandbox = await provider.create({
        id: `live-source-${randomUUID()}`,
        image: "node:22",
        projectId: randomUUID(),
        runId: null,
      });
      const adapter = new MastraWorkspaceSandboxAdapter({ sandbox });
      await adapter.start();
      await adapter.executeCommand(
        "mkdir -p node_modules .reasonate nested/node_modules\nprintf hidden > .reasonate/private\nprintf hidden > nested/node_modules/private\nln -s /etc/passwd escaped\nln -s .reasonate/private concealed\nprintf '\\000' > image.bin\nhead -c 300000 /dev/zero > large.bin"
      );
      await Promise.all(
        [
          "../etc/passwd",
          "/etc/passwd",
          "escaped",
          "concealed",
          ".reasonate/private",
          "nested/node_modules/private",
        ].map((path) =>
          expect(readLiveWorkspace(sandbox, path)).rejects.toThrow(
            "could not be read"
          )
        )
      );
      await sandbox.writeFile(
        "--eval=process.stdout.write(123)",
        "literal option filename"
      );
      expect(
        WorkspaceFileSchema.parse(
          await readLiveWorkspace(sandbox, "--eval=process.stdout.write(123)")
        ).text
      ).toBe("literal option filename");
      await sandbox.writeFile("src/build/deploy.ts", "source preserved");
      expect(
        WorkspaceFileSchema.parse(
          await readLiveWorkspace(sandbox, "src/build/deploy.ts")
        ).text
      ).toBe("source preserved");
      const tree = WorkspaceTreeSchema.parse(await readLiveWorkspace(sandbox));
      expect(tree.files.map((entry) => entry.path)).not.toContain("escaped");
      expect(tree.files.map((entry) => entry.path)).not.toContain(
        "nested/node_modules/private"
      );
      expect(
        WorkspaceFileSchema.parse(await readLiveWorkspace(sandbox, "large.bin"))
      ).toMatchObject({ binary: true, text: "" });
      await sandbox.writeFile("large.txt", "a".repeat(300_000));
      const largeText = WorkspaceFileSchema.parse(
        await readLiveWorkspace(sandbox, "large.txt")
      );
      expect(largeText).toMatchObject({
        binary: false,
        bytes: 300_000,
        truncated: true,
      });
      expect(largeText.text).toHaveLength(262_144);
      expect(
        WorkspaceFileSchema.parse(await readLiveWorkspace(sandbox, "image.bin"))
      ).toMatchObject({ binary: true, text: "" });
      await adapter.executeCommand(
        "mkfifo blocked.pipe\nnode -e \"const fs=require('node:fs');fs.mkdirSync('many');for(let i=0;i<5100;i++)fs.writeFileSync('many/'+i,'');\""
      );
      await expect(readLiveWorkspace(sandbox, "blocked.pipe")).rejects.toThrow(
        "could not be read"
      );
      const bounded = WorkspaceTreeSchema.parse(
        await readLiveWorkspace(sandbox)
      );
      expect(bounded.truncated).toBe(true);
      expect(bounded.files.length).toBeLessThanOrEqual(5000);
      expect(bounded.files.some((entry) => entry.path === "blocked.pipe")).toBe(
        false
      );
    });
  }
);
