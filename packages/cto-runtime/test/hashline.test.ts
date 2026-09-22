import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyEditRequest } from "../src/tools/edit.js";
import {
  computeFileHash,
  formatHashlineHeader,
} from "../src/tools/hashline/format.js";
import { NodeFilesystem } from "../src/tools/hashline/fs.js";
import { Patch } from "../src/tools/hashline/input.js";
import { RECOVERY_LINE_REMAP_WARNING } from "../src/tools/hashline/messages.js";
import { MismatchError } from "../src/tools/hashline/mismatch.js";
import { Patcher } from "../src/tools/hashline/patcher.js";
import { InMemorySnapshotStore } from "../src/tools/hashline/snapshots.js";
import { ReadSnapshotStore } from "../src/tools/read-snapshots.js";
import { writeFileContent } from "../src/tools/write.js";

const filesystem = new NodeFilesystem();

const TAG_SHAPE_RE = /^[0-9A-F]{4}$/;
const NOT_FROM_SESSION_RE = /not from this session/;
const NEVER_DISPLAYED_RE = /never displayed/;
const DOES_NOT_EXIST_RE = /does not exist/;
const NO_CHANGES_RE = /resulted in no changes being made/;
const NO_BODY_ROWS_RE = /does not take body rows/;
const MUST_BEGIN_WITH_RE = /must begin with/;
const CHANGED_BETWEEN_RE = /file changed between read and edit/;

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-hashline-"));
  await Promise.all(
    Object.entries(files).map(async ([relative, content]) => {
      const target = join(root, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    })
  );
  return root;
}

interface Session {
  file: string;
  patcher: Patcher;
  store: InMemorySnapshotStore;
  tag: string;
  text: string;
}

/**
 * Build a real on-disk file plus the session state `read` would have produced:
 * the snapshot store holds the exact text and the lines that were displayed.
 * `seenLines` defaults to every line (a whole-file read); pass `null` to record
 * the text with no display provenance at all.
 */
async function openSession(
  relative: string,
  content: string,
  seenLines?: number[] | null
): Promise<Session> {
  const root = await workspace({ [relative]: content });
  const file = join(root, relative);
  const store = new InMemorySnapshotStore();
  const patcher = new Patcher({ fs: filesystem, snapshots: store });
  const text = await readFile(file, "utf8");
  const tag =
    seenLines === null
      ? store.record(file, text)
      : store.record(
          file,
          text,
          seenLines ?? text.split("\n").map((_, index) => index + 1)
        );
  return { file, patcher, store, tag, text };
}

function section(file: string, tag: string, ops: string): string {
  return `[${file}#${tag}]\n${ops}\n`;
}

describe("anchor tags", () => {
  it("mints the same tag for the same content", () => {
    const first = computeFileHash("const a = 1;\nconst b = 2;\n");
    const second = computeFileHash("const a = 1;\nconst b = 2;\n");

    expect(first).toBe(second);
    expect(first).toMatch(TAG_SHAPE_RE);
  });

  it("ignores trailing whitespace and CRLF so a re-read never invalidates a tag", () => {
    expect(computeFileHash("a \nb\t\r\n")).toBe(computeFileHash("a\nb\n"));
  });

  it("formats the header the model copies back into an edit", () => {
    expect(formatHashlineHeader("src/app.ts", "1A2B")).toBe(
      "[src/app.ts#1A2B]"
    );
  });

  it("resolves the tag a read minted to the text the model was shown", async () => {
    const snapshots = new ReadSnapshotStore();
    const root = await workspace({ "app.ts": "one\ntwo\nthree\n" });
    const file = join(root, "app.ts");
    const canonical = await snapshots.canonicalPath(file);
    const tag = await snapshots.record(file, "one\ntwo\nthree\n", [1, 2, 3]);

    expect(tag).toBe(computeFileHash("one\ntwo\nthree\n"));

    const patcher = new Patcher({ fs: filesystem, snapshots: snapshots.store });
    const result = await patcher.apply(
      Patch.parse(section(canonical, tag ?? "", "SWAP 1.=1:\n+ONE\n"))
    );

    expect(result.sections[0]?.op).toBe("update");
    expect(await readFile(file, "utf8")).toBe("ONE\ntwo\nthree\n");
  });
});

describe("applying an anchored edit", () => {
  it("replaces the anchored range and reports the line that changed", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\n");

    const result = await session.patcher.apply(
      Patch.parse(
        section(session.file, session.tag, "SWAP 2.=2:\n+two changed\n")
      )
    );

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.op).toBe("update");
    expect(result.sections[0]?.firstChangedLine).toBe(2);
    expect(await readFile(session.file, "utf8")).toBe(
      "one\ntwo changed\nthree\n"
    );
  });

  it("hands back the tag for the text it wrote so the next edit can anchor on it", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\n");

    const first = await session.patcher.apply(
      Patch.parse(
        section(session.file, session.tag, "SWAP 1.=2:\n+ONE\n+TWO\n")
      )
    );
    const written = "ONE\nTWO\nthree\n";
    const header = first.sections[0]?.header ?? "";

    expect(header).toBe(
      formatHashlineHeader(session.file, computeFileHash(written))
    );

    const second = await session.patcher.apply(
      Patch.parse(
        section(
          session.file,
          first.sections[0]?.fileHash ?? "",
          "INS.TAIL:\n+four\n"
        )
      )
    );

    expect(second.sections[0]?.op).toBe("update");
    expect(await readFile(session.file, "utf8")).toBe(
      "ONE\nTWO\nthree\nfour\n"
    );
  });
});

describe("refusing an edit that would corrupt the file", () => {
  it("refuses a stale tag instead of applying over content that changed", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\nfour\n");
    const changed = "one\ntwo\nNINE\nfour\n";
    await writeFile(session.file, changed, "utf8");

    await expect(
      session.patcher.apply(
        Patch.parse(section(session.file, session.tag, "SWAP 3.=3:\n+THREE\n"))
      )
    ).rejects.toBeInstanceOf(MismatchError);

    expect(await readFile(session.file, "utf8")).toBe(changed);
  });

  it("says a tag this session never minted is not from this session", async () => {
    const session = await openSession("app.ts", "one\ntwo\n");
    const fabricated = session.tag === "9F3E" ? "1A2B" : "9F3E";

    await expect(
      session.patcher.apply(
        Patch.parse(section(session.file, fabricated, "SWAP 1.=1:\n+ONE\n"))
      )
    ).rejects.toThrow(NOT_FROM_SESSION_RE);

    expect(await readFile(session.file, "utf8")).toBe("one\ntwo\n");
  });

  it("refuses to touch a line the read that minted the tag never displayed", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\n", [1, 2]);

    await expect(
      session.patcher.apply(
        Patch.parse(section(session.file, session.tag, "SWAP 3.=3:\n+THREE\n"))
      )
    ).rejects.toThrow(NEVER_DISPLAYED_RE);

    expect(await readFile(session.file, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("accepts the straight retry once the rejection revealed the line", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\n", [1, 2]);
    const edit = Patch.parse(
      section(session.file, session.tag, "SWAP 3.=3:\n+THREE\n")
    );

    await expect(session.patcher.apply(edit)).rejects.toThrow(
      NEVER_DISPLAYED_RE
    );

    const retry = await session.patcher.apply(edit);
    expect(retry.sections[0]?.op).toBe("update");
    expect(await readFile(session.file, "utf8")).toBe("one\ntwo\nTHREE\n");
  });

  it("refuses an edit anchored past the end of the file", async () => {
    const session = await openSession("app.ts", "one\ntwo\n", null);

    await expect(
      session.patcher.apply(
        Patch.parse(section(session.file, session.tag, "SWAP 9.=9:\n+nine\n"))
      )
    ).rejects.toThrow(DOES_NOT_EXIST_RE);

    expect(await readFile(session.file, "utf8")).toBe("one\ntwo\n");
  });
});

describe("no-op and malformed patches", () => {
  it("reports a no-op instead of pretending it wrote", async () => {
    const session = await openSession("app.ts", "one\ntwo\nthree\n");

    const result = await session.patcher.apply(
      Patch.parse(section(session.file, session.tag, "SWAP 2.=2:\n+two\n"))
    );

    expect(result.sections[0]?.op).toBe("noop");
    expect(await readFile(session.file, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("refuses a batch whose matching section would apply no change", async () => {
    const root = await workspace({
      "one.ts": "const a = 1;\nconst b = 2;\n",
      "two.ts": "const c = 3;\n",
    });
    const store = new InMemorySnapshotStore();
    const patcher = new Patcher({ fs: filesystem, snapshots: store });
    const one = join(root, "one.ts");
    const two = join(root, "two.ts");
    const oneTag = store.record(one, await readFile(one, "utf8"));
    const twoTag = store.record(two, await readFile(two, "utf8"));

    const batch = `${section(one, oneTag, "SWAP 1.=1:\n+const a = 1;\n")}${section(
      two,
      twoTag,
      "SWAP 1.=1:\n+const c = 30;\n"
    )}`;

    await expect(patcher.apply(Patch.parse(batch))).rejects.toThrow(
      NO_CHANGES_RE
    );

    // All-or-nothing: the section that would have changed must not be written.
    expect(await readFile(two, "utf8")).toBe("const c = 3;\n");
  });

  it("refuses a malformed section without partially applying the batch", async () => {
    const root = await workspace({
      "one.ts": "const a = 1;\n",
      "two.ts": "const c = 3;\n",
    });
    const store = new InMemorySnapshotStore();
    const patcher = new Patcher({ fs: filesystem, snapshots: store });
    const one = join(root, "one.ts");
    const two = join(root, "two.ts");
    const oneTag = store.record(one, await readFile(one, "utf8"));
    const twoTag = store.record(two, await readFile(two, "utf8"));

    // The second section hands a body row to a range delete, which is
    // rejected by the parser: `DEL N.=M` takes no body.
    const batch = `${section(one, oneTag, "SWAP 1.=1:\n+const a = 10;\n")}${section(
      two,
      twoTag,
      "DEL 1\n+const c = 30;\n"
    )}`;

    await expect(patcher.apply(Patch.parse(batch))).rejects.toThrow(
      NO_BODY_ROWS_RE
    );

    expect(await readFile(one, "utf8")).toBe("const a = 1;\n");
    expect(await readFile(two, "utf8")).toBe("const c = 3;\n");
  });

  it("refuses input that is not a hashline patch at all", () => {
    expect(() => Patch.parse("*** Update File: app.ts\n@@ -1 +1 @@\n")).toThrow(
      MUST_BEGIN_WITH_RE
    );
  });
});

describe("stale-tag recovery", () => {
  it("remaps how anchors moved when the anchored lines themselves are untouched", async () => {
    const session = await openSession(
      "app.ts",
      "a1\na2\na3\na4\na5\na6\na7\na8\na9\n"
    );
    // A prior edit inserted a line above the anchor AND another one inside the
    // tagged hunk's context window, so the 3-way merge cannot re-fit the patch
    // while every anchored line still reads the same.
    const drifted = "x0\na1\na2\na3\na4\na5\na6\ny0\na7\na8\na9\n";
    await writeFile(session.file, drifted, "utf8");

    const result = await session.patcher.apply(
      Patch.parse(section(session.file, session.tag, "SWAP 5.=5:\n+A5\n"))
    );

    expect(result.sections[0]?.warnings).toContain(RECOVERY_LINE_REMAP_WARNING);
    expect(await readFile(session.file, "utf8")).toBe(
      "x0\na1\na2\na3\na4\nA5\na6\ny0\na7\na8\na9\n"
    );
  });

  it("still refuses when the drift touched the anchored line itself", async () => {
    const session = await openSession(
      "app.ts",
      "a1\na2\na3\na4\na5\na6\na7\na8\na9\n"
    );
    await writeFile(
      session.file,
      "a1\na2\na3\na4\nCHANGED\na6\na7\na8\na9\n",
      "utf8"
    );

    await expect(
      session.patcher.apply(
        Patch.parse(section(session.file, session.tag, "SWAP 5.=5:\n+A5\n"))
      )
    ).rejects.toBeInstanceOf(MismatchError);

    expect(await readFile(session.file, "utf8")).toBe(
      "a1\na2\na3\na4\nCHANGED\na6\na7\na8\na9\n"
    );
  });
});

describe("the write tool", () => {
  it("creates a missing file, parents included, and diffs it from nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "reasonate-hashline-"));
    const target = join(root, "nested", "file.ts");

    const result = await writeFileContent({
      content: "const a = 1;\n",
      path: target,
    });

    expect(result.created).toBe(true);
    expect(result.path).toBe(target);
    expect(result.patch).toContain("/dev/null");
    expect(result.patch).toContain("+const a = 1;");
    expect(await readFile(target, "utf8")).toBe("const a = 1;\n");
  });

  it("overwrites an existing file and reports both sides of the change", async () => {
    const root = await workspace({ "file.ts": "const a = 1;\n" });
    const target = join(root, "file.ts");

    const result = await writeFileContent({
      content: "const a = 2;\n",
      path: target,
    });

    expect(result.created).toBe(false);
    expect(result.patch).toContain("-const a = 1;");
    expect(result.patch).toContain("+const a = 2;");
    expect(await readFile(target, "utf8")).toBe("const a = 2;\n");
  });
});

describe("the edit tool", () => {
  it("applies an exact replacement and reports the diff", async () => {
    const root = await workspace({ "file.ts": "const a = 1;\nconst b = 2;\n" });
    const target = join(root, "file.ts");

    const outcome = await applyEditRequest(
      { newString: "const b = 3;", oldString: "const b = 2;", path: target },
      { cwd: root }
    );

    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
    expect(outcome.output).toContain("+const b = 3;");
    expect(await readFile(target, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("refuses an oldString that does not match and leaves the file alone", async () => {
    const original = "const a = 1;\nconst b = 2;\n";
    const root = await workspace({ "file.ts": original });
    const target = join(root, "file.ts");

    const outcome = await applyEditRequest(
      { newString: "const z = 9;", oldString: "const z = 9;", path: target },
      { cwd: root }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.error).toContain("Could not find the specified text");
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("applies a patch through the tool and mints the header for the next edit", async () => {
    const root = await workspace({ "file.ts": "one\ntwo\n" });
    const target = join(root, "file.ts");
    const snapshots = new ReadSnapshotStore();
    const text = await readFile(target, "utf8");
    const tag = await snapshots.record(target, text, [1, 2]);

    const outcome = await applyEditRequest(
      { patch: `[${target}#${tag}]\nSWAP 2.=2:\n+TWO\n` },
      { snapshots }
    );

    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
    const written = "one\nTWO\n";
    expect(outcome.output).toContain("update");
    expect(outcome.output).toContain(
      formatHashlineHeader(target, computeFileHash(written))
    );
    expect(await readFile(target, "utf8")).toBe(written);
  });

  it("refuses a patch whose tag is stale, writing nothing", async () => {
    const root = await workspace({ "file.ts": "one\ntwo\nthree\nfour\n" });
    const target = join(root, "file.ts");
    const snapshots = new ReadSnapshotStore();
    const tag = await snapshots.record(
      target,
      await readFile(target, "utf8"),
      [1, 2, 3, 4]
    );
    const changed = "one\ntwo\nNINE\nfour\n";
    await writeFile(target, changed, "utf8");

    const outcome = await applyEditRequest(
      { patch: `[${target}#${tag}]\nSWAP 3.=3:\n+THREE\n` },
      { snapshots }
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.error).toMatch(CHANGED_BETWEEN_RE);
    expect(await readFile(target, "utf8")).toBe(changed);
  });
});
