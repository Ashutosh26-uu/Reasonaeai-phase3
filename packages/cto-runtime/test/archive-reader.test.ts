import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { archiveReader } from "../src/tools/readers/archive.js";
import {
  DEFAULT_READER_LIMITS,
  ReaderLimitError,
  type ReaderLimits,
  type ReaderRequest,
  UnsupportedFormatError,
} from "../src/tools/readers/types.js";

const README = "hello archive";
const GUIDE = "# guide\n";

/** Write real container bytes into a temp file and return its path. */
async function writeContainer(
  name: string,
  bytes: Uint8Array
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-archive-"));
  const target = join(root, name);
  await writeFile(target, bytes);
  return target;
}

/** Read through the reader and hand back the error it threw. */
async function readError(request: ReaderRequest): Promise<Error> {
  try {
    await archiveReader.read(request);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`expected an Error, got ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error("expected the read to fail");
}

/**
 * Rewrite the first central-directory record's declared uncompressed size.
 *
 * That field is the only difference between a small container and a bomb, so
 * patching it is how a bomb is built without shipping one.
 */
function declareInflatedMember(
  zip: Uint8Array,
  declaredSize: number
): Uint8Array {
  const patched = Uint8Array.from(zip);
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength
  );

  for (let offset = 0; offset + 46 <= patched.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
      continue;
    }
    view.setUint32(offset + 24, declaredSize, true);
    return patched;
  }

  throw new Error("fixture has no central-directory record");
}

describe("listing a container", () => {
  it("lists every entry with its size when no member is named", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({
        "docs/guide.md": strToU8(GUIDE),
        "readme.txt": strToU8(README),
      })
    );

    const result = await archiveReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: archivePath,
      selector: undefined,
    });

    expect(result.text).toContain("f readme.txt 13 bytes");
    expect(result.text).toContain("d docs/");
    expect(result.text).toContain("2 entries");
    expect(result.immutable).toBe(true);
    expect(result.contentType).toBe("text/plain");
  });

  it("lists one level inside a named directory", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({
        "docs/guide.md": strToU8(GUIDE),
        "docs/notes.txt": strToU8("notes"),
        "readme.txt": strToU8(README),
      })
    );

    const result = await archiveReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:docs`,
      selector: undefined,
    });

    expect(result.text).toContain(
      "sample.zip:docs — 2 of the container's 3 entries"
    );
    expect(result.text).toContain("f guide.md 8 bytes");
    expect(result.text).toContain("f notes.txt 5 bytes");
    expect(result.text).not.toContain("readme.txt");
  });
});

describe("reading a member", () => {
  it("returns the addressed member's text", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "readme.txt": strToU8(README) })
    );

    const result = await archiveReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:readme.txt`,
      selector: undefined,
    });

    expect(result.text).toBe(README);
    expect(result.immutable).toBe(true);
  });

  it("resolves a member nested inside the container", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "docs/guide.md": strToU8(GUIDE) })
    );

    const result = await archiveReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:docs/guide.md`,
      selector: undefined,
    });

    expect(result.text).toBe(GUIDE);
  });

  it("accepts a member named in the selector", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "docs/guide.md": strToU8(GUIDE) })
    );

    const result = await archiveReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: archivePath,
      selector: "docs/guide.md",
    });

    expect(result.text).toBe(GUIDE);
  });
});

describe("missing members", () => {
  it("fails naming what the container does hold", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({
        "docs/guide.md": strToU8(GUIDE),
        "readme.txt": strToU8(README),
      })
    );

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:missing.txt`,
      selector: undefined,
    });

    expect(failure.message).toContain("Archive member not found: missing.txt");
    expect(failure.message).toContain("f readme.txt 13 bytes");
    expect(failure.message).toContain("d docs/");
  });

  it("refuses a member path that climbs out of the container", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "readme.txt": strToU8(README) })
    );

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:../escape.txt`,
      selector: undefined,
    });

    expect(failure.message).toContain("traversal is not allowed");
  });
});

describe("limits", () => {
  it("refuses a container over maxArchiveBytes", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "readme.txt": strToU8(README) })
    );
    const limits: ReaderLimits = {
      ...DEFAULT_READER_LIMITS,
      maxArchiveBytes: 8,
    };

    const failure = await readError({
      limits,
      path: archivePath,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(ReaderLimitError);
    if (!(failure instanceof ReaderLimitError)) {
      throw new Error(failure.message);
    }
    expect(failure.limit).toContain("maxArchiveBytes");
    expect(failure.message).toContain("maxArchiveBytes");
  });

  it("refuses a member over maxArchiveMemberBytes, naming the member and the bound", async () => {
    const archivePath = await writeContainer(
      "sample.zip",
      zipSync({ "readme.txt": strToU8(README) })
    );

    const failure = await readError({
      limits: { ...DEFAULT_READER_LIMITS, maxArchiveMemberBytes: 4 },
      path: `${archivePath}:readme.txt`,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(ReaderLimitError);
    if (!(failure instanceof ReaderLimitError)) {
      throw new Error(failure.message);
    }
    expect(failure.limit).toContain("maxArchiveMemberBytes");
    expect(failure.limit).toContain("readme.txt");
    expect(failure.observed).toBe(README.length);
    expect(failure.message).toContain("4-byte limit");
  });
});

describe("compression bombs", () => {
  it("refuses a container whose declared sizes cannot be honest", async () => {
    const archivePath = await writeContainer(
      "bomb.zip",
      declareInflatedMember(
        zipSync({ "readme.txt": strToU8(README) }),
        0x40_00_00_00
      )
    );

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: archivePath,
      selector: undefined,
    });

    expect(failure.message).toContain("Refusing");
    expect(failure.message).toContain("1073741824 uncompressed bytes");
    expect(failure.message).toContain("compression bomb");
  });
});

describe("binaries and broken containers", () => {
  it("refuses to return a binary member as text", async () => {
    const archivePath = await writeContainer(
      "blobs.zip",
      zipSync({ "blob.bin": new Uint8Array([0x00, 0x01, 0xff]) })
    );

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: `${archivePath}:blob.bin`,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(UnsupportedFormatError);
    expect(failure.message).toContain("blob.bin");
    expect(failure.message).toContain("binary");
  });

  it("refuses a .zip whose bytes are not a container", async () => {
    const archivePath = await writeContainer(
      "broken.zip",
      strToU8("this is not a zip file at all")
    );

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: archivePath,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(UnsupportedFormatError);
    expect(failure.message).toContain("broken.zip");
  });
});

describe("dispatch", () => {
  it("claims zip-family containers and their members", () => {
    expect(
      archiveReader.matches({ path: "/tmp/a.zip", selector: undefined })
    ).toBe(true);
    expect(
      archiveReader.matches({
        path: "/tmp/a.zip:docs/guide.md",
        selector: undefined,
      })
    ).toBe(true);
    expect(
      archiveReader.matches({ path: "/tmp/lib/app.jar", selector: undefined })
    ).toBe(true);
  });

  it("declines tar so the tool falls through", () => {
    expect(
      archiveReader.matches({ path: "/tmp/notes.tar", selector: undefined })
    ).toBe(false);
    expect(
      archiveReader.matches({ path: "/tmp/notes.tgz", selector: undefined })
    ).toBe(false);
    expect(
      archiveReader.matches({
        path: "/tmp/notes.tar.gz:inner.txt",
        selector: undefined,
      })
    ).toBe(false);
    // A nested address resolves through the outer-most archive extension, which
    // here is tar, so it is declined rather than half-read as a zip.
    expect(
      archiveReader.matches({
        path: "/tmp/a.zip:b.tar.gz:c",
        selector: undefined,
      })
    ).toBe(false);
  });

  it("leaves non-archives and URLs to other readers", () => {
    expect(
      archiveReader.matches({ path: "/tmp/a.txt", selector: undefined })
    ).toBe(false);
    expect(
      archiveReader.matches({ path: "/tmp/report.pdf", selector: undefined })
    ).toBe(false);
    expect(
      archiveReader.matches({
        path: "https://example.com/a.zip",
        selector: undefined,
      })
    ).toBe(false);
  });

  it("refuses a tar address when asked to read it directly", async () => {
    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: "/tmp/notes.tar.gz:inner.txt",
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(UnsupportedFormatError);
    expect(failure.message).toContain("Tar archives are not supported");
  });
});
