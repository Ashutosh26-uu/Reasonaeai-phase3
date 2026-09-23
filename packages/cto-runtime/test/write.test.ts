import { describe, expect, it } from "vitest";
import { InMemoryFilesystem } from "../src/tools/hashline/fs.js";
import { ReadSnapshotStore } from "../src/tools/read-snapshots.js";
import { writeFileWithHash } from "../src/tools/write.js";

const COMPLETE_READ_RE = /complete read/;
const EXPECTED_HASH_RE = /expectedHash/;

describe("hash-bound write", () => {
  it("creates a new file and refuses a blind replacement", async () => {
    const filesystem = new InMemoryFilesystem();
    const snapshots = new ReadSnapshotStore();

    const created = await writeFileWithHash(
      { content: "first\n", path: "/workspace/app.ts" },
      { filesystem, root: "/workspace", snapshots }
    );

    expect(created.created).toBe(true);
    expect(created.patch).toContain("/dev/null");
    await expect(
      writeFileWithHash(
        { content: "second\n", path: "/workspace/app.ts" },
        { filesystem, root: "/workspace", snapshots }
      )
    ).rejects.toThrow(EXPECTED_HASH_RE);
  });

  it("requires a complete current read before replacing content", async () => {
    const filesystem = new InMemoryFilesystem([
      ["/workspace/app.ts", "first\nsecond\n"],
    ]);
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);
    const tag = await snapshots.record(
      "/workspace/app.ts",
      "first\nsecond\n",
      [1, 2]
    );

    const replaced = await writeFileWithHash(
      {
        content: "updated\n",
        expectedHash: tag,
        path: "/workspace/app.ts",
      },
      { filesystem, root: "/workspace", snapshots }
    );

    expect(replaced.created).toBe(false);
    expect(replaced.patch).toContain("-first");
    expect(filesystem.get("/workspace/app.ts")).toBe("updated\n");
  });

  it("rejects a partial read before a full replacement", async () => {
    const filesystem = new InMemoryFilesystem([
      ["/workspace/app.ts", "first\nsecond\n"],
    ]);
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);
    const tag = await snapshots.record(
      "/workspace/app.ts",
      "first\nsecond\n",
      [1]
    );

    await expect(
      writeFileWithHash(
        {
          content: "updated\n",
          expectedHash: tag,
          path: "/workspace/app.ts",
        },
        { filesystem, root: "/workspace", snapshots }
      )
    ).rejects.toThrow(COMPLETE_READ_RE);
  });
});
