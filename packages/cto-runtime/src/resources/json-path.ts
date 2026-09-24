/**
 * Path addressing into a JSON document.
 *
 * An agent that returned a large JSON result is usually asked about one field of
 * it. Extraction lets a read pull `agent://reviewer_0/.findings` instead of
 * spending the whole document's context budget on a lookup the handler can do
 * exactly.
 *
 * Grammar, which both URL forms share:
 *
 * - `a.b.c` or `.a.b.c` — object members, in order
 * - `a[0]` or `a.0` — array elements, by zero-based index
 * - `keys` — the member names of an object, which is how a model finds out what
 *   is available without guessing
 *
 * A segment that does not exist is reported with the keys that do exist, because
 * the useful answer to a wrong path is the shape of the right one.
 */

/** How a path segment addresses a value. */
export type PathSegment =
  | { kind: "member"; name: string }
  | { kind: "index"; index: number }
  | { kind: "keys" };

const MEMBER_INDEX_RE = /^\[(\d+)\]$/;
const LEADING_SEPARATOR_RE = /^[/.]/;
const SEPARATOR_RE = /[/.]/;
const DIGITS_RE = /^\d+$/;

/** A wrong path, reported with the shape of the value that was addressed. */
export class PathLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathLookupError";
  }
}

/** Describe a value's shape, so a failed lookup can name what it found. */
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `an array of ${value.length}`;
  }
  if (typeof value === "object") {
    return `an object with keys: ${Object.keys(value).join(", ") || "none"}`;
  }
  return `a ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Split a bracketed index off the end of a segment, e.g. `items[2]`. */
function splitMember(member: string, segments: PathSegment[]): void {
  // A bare numeric segment addresses an array element, so `findings.0.id` and
  // `findings[0].id` mean the same thing.
  if (DIGITS_RE.test(member)) {
    segments.push({ index: Number.parseInt(member, 10), kind: "index" });
    return;
  }

  if (!member.includes("[")) {
    if (member !== "") {
      segments.push({ kind: "member", name: member });
    }
    return;
  }

  const bracketIndex = member.indexOf("[");
  const name = member.slice(0, bracketIndex);
  if (name !== "") {
    segments.push({ kind: "member", name });
  }

  const indexMatch: RegExpExecArray | null = MEMBER_INDEX_RE.exec(
    member.slice(bracketIndex)
  );
  if (indexMatch === null) {
    segments.push({ kind: "member", name: member });
    return;
  }

  segments.push({
    index: Number.parseInt(indexMatch[1] as string, 10),
    kind: "index",
  });
}

/**
 * Parse a path or query form into segments.
 *
 * `/.findings.title`, `.findings.title`, and `findings/title` all parse the
 * same, so the same lookup can be written as a URL path or as a `?q=` value
 * without the caller remembering which form the scheme expects.
 */
export function parsePathSegments(input: string): PathSegment[] {
  const trimmed = input.trim().replace(LEADING_SEPARATOR_RE, "");
  if (trimmed === "") {
    return [];
  }

  const segments: PathSegment[] = [];

  for (const part of trimmed.split(SEPARATOR_RE)) {
    if (part === "") {
      continue;
    }
    if (part === "keys") {
      segments.push({ kind: "keys" });
      continue;
    }
    splitMember(part, segments);
  }

  return segments;
}

function readKeys(current: unknown): string[] {
  if (!isPlainObject(current)) {
    throw new PathLookupError(
      `Cannot list keys: the value is ${describe(current)}.`
    );
  }
  return Object.keys(current);
}

function readIndex(current: unknown, index: number): unknown {
  if (!Array.isArray(current)) {
    throw new PathLookupError(
      `Cannot index [${index}]: the value is ${describe(current)}.`
    );
  }
  if (index < 0 || index >= current.length) {
    throw new PathLookupError(
      `Index [${index}] is out of range: the array has ${current.length} entries.`
    );
  }
  return current[index];
}

function readMember(current: unknown, name: string): unknown {
  if (!isPlainObject(current)) {
    throw new PathLookupError(
      `Cannot read member "${name}": the value is ${describe(current)}.`
    );
  }
  if (!Object.hasOwn(current, name)) {
    throw new PathLookupError(
      `No member "${name}". Available: ${Object.keys(current).join(", ") || "none"}`
    );
  }
  return current[name];
}

/**
 * Apply parsed segments to a JSON value.
 *
 * Throws {@link PathLookupError} for a missing member or an out-of-range index.
 */
export function applyPathSegments(
  value: unknown,
  segments: readonly PathSegment[]
): unknown {
  let current: unknown = value;

  for (const segment of segments) {
    if (segment.kind === "keys") {
      return readKeys(current);
    }
    current =
      segment.kind === "index"
        ? readIndex(current, segment.index)
        : readMember(current, segment.name);
  }

  return current;
}

/** Render an extracted value the way it should appear to the model. */
export function formatExtracted(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}
