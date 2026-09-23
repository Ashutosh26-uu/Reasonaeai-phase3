/**
 * The archive reader: ZIP-family containers and the members inside them.
 *
 * Ported from spectra's `archive-reader.ts`, with three runtime-edge changes:
 *
 * - Containers are read with `fflate` rather than Bun's `Archive`. `fflate` reads
 *   the ZIP family only, so tar is recognised purely in order to be declined:
 *   `matches` returns false for a tar address and a direct `read` refuses it,
 *   rather than letting tar bytes be parsed as a ZIP.
 * - Bounds come from `ReaderLimits` and are enforced through `assertWithinLimit`,
 *   so a member past `maxArchiveMemberBytes` is an error that states the bound
 *   and names the member. The original filtered oversized members out of the
 *   unzip pass, which a caller can only read as "that member does not exist".
 * - A member is never returned as a binary dump. A member whose bytes are not
 *   text is refused, because noise presented as content cannot be told apart
 *   from content.
 *
 * Member addressing is spectra's: `archive.zip:some/member.txt` reads one member,
 * `archive.zip:some/dir` lists what is directly inside that directory, and a bare
 * `archive.zip` lists the container root. Nothing inside a container is an
 * editable region of a file, so every result is `immutable`.
 */

import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { unzipSync } from "fflate";

import {
  assertWithinLimit,
  type FormatReader,
  type ReaderRequest,
  type ReaderResult,
  UnsupportedFormatError,
} from "./types.js";

/** ZIP-family extensions: the containers `fflate` can decompress. */
const ZIP_EXTENSIONS: readonly string[] = [
  ".zip",
  ".jar",
  ".war",
  ".ear",
  ".apk",
  ".whl",
  ".epub",
  ".docx",
  ".xlsx",
  ".pptx",
];

/**
 * Tar-family extensions.
 *
 * Listed only so the address parser can name the format and decline it. `fflate`
 * has no tar reader, and hand-rolling one would mean this reader claiming a
 * format it cannot actually parse.
 */
const TAR_EXTENSIONS: readonly string[] = [".tar.gz", ".tgz", ".tar"];

/**
 * Every extension the address parser looks for, longest first, so
 * `docs.tar.gz:inner` resolves through `.tar.gz:` rather than through a shorter
 * suffix that overlaps it.
 */
const ARCHIVE_EXTENSIONS: readonly string[] = [
  ...TAR_EXTENSIONS,
  ...ZIP_EXTENSIONS,
].sort((left, right) => right.length - left.length);

/**
 * The most a single DEFLATE stream can expand, 1032:1, with margin.
 *
 * A container whose entries declare more uncompressed bytes than this can only
 * be overlapping its entries on purpose, which is what a compression bomb is.
 * The check reads the central directory, so it runs before any member is
 * inflated.
 */
const MAX_DECLARED_EXPANSION = 1100;

/** Entry names a "what exists" hint lists before it summarises the remainder. */
const HINT_ENTRY_LIMIT = 20;

/** Backslash separators, which some containers use inside entry names. */
const BACKSLASH_RE = /\\/g;

/** Separators trailing a directory prefix. */
const TRAILING_SEPARATOR_RE = /\/+$/;

/**
 * Member decoding, matching the original: never fatal, so a stray byte yields a
 * replacement character instead of failing the whole read.
 */
const MEMBER_DECODER = new TextDecoder("utf-8", { fatal: false });

/** A resolved `container.zip:member/path` address. */
interface ArchiveAddress {
  /** Absolute path to the container. */
  archivePath: string;
  format: "tar" | "zip";
  /** Normalised member path; empty means the container root. */
  memberPath: string;
}

/** One entry from a container's central directory. */
interface ArchiveEntry {
  /** Compressed size in bytes. */
  compressedSize: number;
  /** Declared uncompressed size in bytes. */
  declaredSize: number;
  /** True when the container stores this entry as a directory. */
  isDirectory: boolean;
  /** Normalised member path: `/` separators, no `.` or empty segments. */
  name: string;
  /** The name exactly as the container stores it, for extraction. */
  rawName: string;
}

/** One level of a listing, with the count so the header can state the total. */
interface ArchiveListing {
  lines: string[];
  total: number;
}

/** What one entry contributes to the listing line for its name. */
interface ListingChild {
  directory: boolean;
  /** Uncompressed size, for entries that are files. */
  size: number | undefined;
}

/**
 * Normalise a member path.
 *
 * `/` and `\` both separate, `.` and empty segments disappear, and `..` is
 * refused: a member address must not be able to climb out of the container.
 */
function normalizeMemberPath(value: string): string {
  const parts: string[] = [];

  for (const part of value.replace(BACKSLASH_RE, "/").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error("Archive member traversal is not allowed");
    }
    parts.push(part);
  }

  return parts.join("/");
}

/**
 * Resolve a read target to the container it names and the member it addresses.
 *
 * Ported from spectra's `parseArchivePath`: the extension scan runs across the
 * whole input, so the outermost archive-looking extension owns the container and
 * everything after its colon is the member. `a.zip:b.tar.gz:c` therefore
 * resolves to the container `a.zip:b.tar.gz` with member `c` — a nested address
 * is declined as tar instead of being half-read as a ZIP.
 *
 * A container named without a member addresses the container root, so a bare
 * `data.zip` becomes a listing rather than being treated as one more binary
 * file. The container is resolved against the process directory, which is a
 * no-op when the caller already resolved it.
 */
export function parseArchiveAddress(input: string): ArchiveAddress | undefined {
  const lower = input.toLowerCase();

  for (const extension of ARCHIVE_EXTENSIONS) {
    const index = lower.indexOf(`${extension}:`);
    if (index === -1) {
      continue;
    }
    return {
      archivePath: resolve(input.slice(0, index + extension.length)),
      format: ZIP_EXTENSIONS.includes(extension) ? "zip" : "tar",
      memberPath: normalizeMemberPath(
        input.slice(index + extension.length + 1)
      ),
    };
  }

  for (const extension of ZIP_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return { archivePath: resolve(input), format: "zip", memberPath: "" };
    }
  }

  return undefined;
}

/**
 * Index a container's central directory without inflating anything.
 *
 * `fflate` calls the filter once per entry with the entry's declared sizes, and
 * declining an entry skips its decompression. Returning false for every entry
 * therefore turns an unzip pass into a cheap index pass: names, declared sizes,
 * and compression method for the whole container.
 */
function scanEntries(bytes: Uint8Array, archivePath: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];

  try {
    unzipSync(bytes, {
      filter: (file) => {
        entries.push({
          compressedSize: file.size,
          declaredSize: file.originalSize,
          isDirectory: file.name.endsWith("/") || file.name.endsWith("\\"),
          name: normalizeMemberPath(file.name),
          rawName: file.name,
        });
        return false;
      },
    });
  } catch (error) {
    throw new UnsupportedFormatError(
      `${archivePath} is not a ZIP container this reader can open`,
      { cause: error }
    );
  }

  return entries;
}

/** Inflate one member, by the name the container stores it under. */
function inflateMember(
  bytes: Uint8Array,
  archivePath: string,
  entry: ArchiveEntry
): Uint8Array {
  try {
    const members = unzipSync(bytes, {
      filter: (file) => file.name === entry.rawName,
    });
    const member = members[entry.rawName];

    if (member === undefined) {
      throw new Error(`No entry named ${entry.rawName} in ${archivePath}`);
    }

    return member;
  } catch (error) {
    throw new UnsupportedFormatError(
      `Archive member ${entry.name} could not be extracted from ${archivePath}`,
      { cause: error }
    );
  }
}

/**
 * Refuse a container whose entries declare an impossible uncompressed total.
 *
 * Overlapping entries are how a ZIP bomb gets a small container to expand
 * without bound, so the check compares the declared total against the container's
 * own size and says which numbers it compared.
 */
function assertPlausibleExpansion(
  entries: readonly ArchiveEntry[],
  containerBytes: number,
  archivePath: string
): void {
  let declared = 0;

  for (const entry of entries) {
    declared += entry.declaredSize;
  }

  if (
    containerBytes === 0 ||
    declared <= containerBytes * MAX_DECLARED_EXPANSION
  ) {
    return;
  }

  throw new Error(
    `Refusing ${archivePath}: its entries declare ${declared} uncompressed bytes inside a ${containerBytes}-byte container (${Math.round(
      declared / containerBytes
    )}x). More than a DEFLATE stream can expand is only possible when entries overlap, which is what a compression bomb is.`
  );
}

/**
 * List the entries directly under a member prefix, one level deep and sorted.
 *
 * One level is what a caller descends with: `archive.zip:src` shows what is
 * inside `src`, not every path in the container. A directory that the container
 * only implies by storing files beneath it is reported as a directory anyway.
 */
function listChildren(
  entries: readonly ArchiveEntry[],
  prefix: string
): ArchiveListing {
  const normalizedPrefix =
    prefix === "" ? "" : `${prefix.replace(TRAILING_SEPARATOR_RE, "")}/`;
  const children = new Map<string, ListingChild>();

  for (const entry of entries) {
    if (!entry.name.startsWith(normalizedPrefix)) {
      continue;
    }

    const remainder = entry.name.slice(normalizedPrefix.length);
    if (remainder === "") {
      continue;
    }

    const slash = remainder.indexOf("/");
    const name = slash === -1 ? remainder : remainder.slice(0, slash);
    const current = children.get(name);
    const directory =
      slash !== -1 || entry.isDirectory || current?.directory === true;

    children.set(name, {
      directory,
      size: directory ? current?.size : entry.declaredSize,
    });
  }

  const lines = [...children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) =>
      child.directory ? `d ${name}/` : `f ${name} ${child.size ?? 0} bytes`
    );

  return { lines, total: children.size };
}

/**
 * Describe a container's top-level entries, for an error that has to name what
 * exists. The count is always stated, so a trimmed hint is never mistaken for
 * the whole container.
 */
function describeRoot(entries: readonly ArchiveEntry[]): string {
  const { lines, total } = listChildren(entries, "");

  if (total === 0) {
    return "The container has no entries.";
  }

  const shown = lines.slice(0, HINT_ENTRY_LIMIT).join(", ");

  return total > HINT_ENTRY_LIMIT
    ? `The container holds ${total} top-level entries: ${shown}, and ${total - HINT_ENTRY_LIMIT} more.`
    : `The container holds: ${shown}`;
}

/** Facts worth surfacing beside an archive result. */
function archiveNotes(
  archivePath: string,
  entryCount: number,
  memberPath: string
): string[] {
  const notes = [
    `archive: ${archivePath}`,
    `entries: ${entryCount}`,
    "format: zip",
  ];

  if (memberPath !== "") {
    notes.push(`member: ${memberPath}`);
  }

  return notes;
}

/** Stat a container, reporting a missing path and a non-file as such. */
async function statContainer(archivePath: string): Promise<Stats> {
  let info: Stats;

  try {
    info = await stat(archivePath);
  } catch (error) {
    throw new Error(`File not found: ${archivePath}`, { cause: error });
  }

  if (!info.isFile()) {
    throw new Error(`Not a regular file: ${archivePath}`);
  }

  return info;
}

/** Render a listing of the container, or of one directory inside it. */
function listingResult(
  archivePath: string,
  entries: readonly ArchiveEntry[],
  memberPath: string
): ReaderResult {
  const listing = listChildren(entries, memberPath);

  if (listing.total === 0 && memberPath !== "") {
    throw new Error(
      `Archive member not found: ${memberPath}. ${describeRoot(entries)}`
    );
  }

  const name = basename(archivePath);
  const header =
    memberPath === ""
      ? `${name} — zip container, ${entries.length} ${entries.length === 1 ? "entry" : "entries"} (listed one level deep)`
      : `${name}:${memberPath} — ${listing.total} of the container's ${entries.length} entries (listed one level deep)`;

  return {
    contentType: "text/plain",
    immutable: true,
    notes: archiveNotes(archivePath, entries.length, memberPath),
    text: [header, ...listing.lines].join("\n"),
  };
}

/** Read one member as text, refusing anything that is not text. */
async function readArchive(request: ReaderRequest): Promise<ReaderResult> {
  const { limits, path: target, selector } = request;
  const address = parseArchiveAddress(target.trim());

  if (address === undefined) {
    throw new UnsupportedFormatError(`${target} is not an archive address`);
  }

  if (address.format === "tar") {
    throw new UnsupportedFormatError(
      `Tar archives are not supported: ${address.archivePath}. This reader opens the ZIP family only: ${ZIP_EXTENSIONS.join(", ")}.`
    );
  }

  const { archivePath } = address;
  // A member can arrive as the selector when the tool peeled it off the path, as
  // `archive.zip:raw` does: `raw` is a line selector, so only the selector is
  // left to carry the member name.
  const memberPath =
    address.memberPath === "" && selector !== undefined
      ? normalizeMemberPath(selector)
      : address.memberPath;

  const info = await statContainer(archivePath);
  assertWithinLimit("maxArchiveBytes", info.size, limits.maxArchiveBytes);

  const bytes = await readFile(archivePath);
  const entries = scanEntries(bytes, archivePath);
  assertPlausibleExpansion(entries, bytes.byteLength, archivePath);

  const entry = entries.findLast(
    (candidate) => candidate.name === memberPath && !candidate.isDirectory
  );

  if (memberPath === "" || entry === undefined) {
    return listingResult(archivePath, entries, memberPath);
  }

  // The bound is named with the member in it: a limit error that does not say
  // which member broke it sends the caller looking through the whole archive.
  assertWithinLimit(
    `maxArchiveMemberBytes for ${memberPath}`,
    entry.declaredSize,
    limits.maxArchiveMemberBytes
  );

  const member = inflateMember(bytes, archivePath, entry);
  assertWithinLimit(
    `maxArchiveMemberBytes for ${memberPath}`,
    member.byteLength,
    limits.maxArchiveMemberBytes
  );

  if (member.includes(0)) {
    throw new UnsupportedFormatError(
      `Archive member ${memberPath} is binary: ${member.byteLength} bytes containing NUL bytes, so it is not text this reader can return.`
    );
  }

  return {
    contentType: "text/plain",
    immutable: true,
    notes: [
      ...archiveNotes(archivePath, entries.length, memberPath),
      `bytes: ${member.byteLength}`,
      `compressed: ${entry.compressedSize}`,
    ],
    text: MEMBER_DECODER.decode(member),
  };
}

/**
 * The archive reader as the read tool consumes it.
 *
 * `matches` claims ZIP-family containers and nothing else: a tar address is
 * recognised by the parser and declined, so the tool falls through to its own
 * handling instead of having tar bytes parsed as a ZIP.
 */
export const archiveReader: FormatReader = {
  extensions: ZIP_EXTENSIONS,
  matches: ({ path }) => {
    const target = path.trim();

    // A URL is the URL reader's target, whatever its suffix looks like.
    if (target.includes("://")) {
      return false;
    }

    return parseArchiveAddress(target)?.format === "zip";
  },
  name: "archive",
  read: readArchive,
};
