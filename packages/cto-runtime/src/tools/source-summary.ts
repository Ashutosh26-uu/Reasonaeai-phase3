/**
 * A structural summary for a large source file.
 *
 * A three-thousand-line source file is mostly bodies, and what a caller needs
 * first is the shape: which declarations exist and where they start. The summary
 * keeps every header line and replaces each body long enough to be worth
 * collapsing with a marker naming the lines it hides. Nothing becomes
 * unreachable, because the closing footer names the selector that reads the
 * elided ranges back, and the caller already has the path.
 *
 * Three properties keep that honest:
 *
 * - It is opt in. `summarizeSource` is a plain function over text, so the read
 *   tool decides when a read is a whole-file source read. A caller that named a
 *   line range, `raw`, or `conflicts` asked a different question and must get
 *   exactly those lines; substituting a summary would answer the question that
 *   was not asked.
 * - It is bounded. A summary never exceeds `MAX_SUMMARY_LINES` lines. Past that
 *   the tail is elided as well, and the footer says so and names the tail, so
 *   the bound stays announced rather than silent.
 * - It refuses instead of guessing. A file below `MIN_SUMMARY_LINES`, a language
 *   with no parser, and a parse with syntax errors all return `undefined`, which
 *   means "no summary": the caller renders the file normally.
 *
 * Parsing is the one thing that cannot be copied from spectra as source. Spectra
 * summarises with tree-sitter — `tree-sitter` plus one grammar package per
 * language — and those grammars are native addons, not TypeScript. So the
 * default parser is layered: it uses tree-sitter when those packages happen to
 * be installed, and otherwise falls back to `parseBraceStructure`, a pure
 * TypeScript scanner that finds the same brace-delimited bodies. A caller can
 * override both through `SummarizeOptions.parse`.
 */

import { createRequire } from "node:module";
import { extname } from "node:path";

/** Shortest file, in lines, that may be replaced by a structural summary. */
export const MIN_SUMMARY_LINES = 300;

/** Fewest interior lines a body needs before collapsing it is worth a marker. */
export const MIN_BODY_LINES = 8;

/** Largest summary, in lines. Beyond this the tail is elided as well. */
export const MAX_SUMMARY_LINES = 1200;

/** Most recovery ranges named inline in the footer's selector hint. */
export const MAX_FOOTER_SELECTORS = 8;

/**
 * Node kinds whose interior may be elided.
 *
 * These are the kinds that hold a body: a function's statements, a class's
 * members, an object's properties, a call's arguments, a block comment's text.
 * Eliding the interior rather than the whole node is the point — the header line
 * survives, and the header is what tells the model whether re-reading the body
 * is worth a round trip.
 */
const BODY_LIKE_RE =
  /(?:body|block|statement_block|compound_statement|class_body|object|array|comment|argument_list|parameters)/;

/** A node in the shape the elision walk needs. */
export interface SourceNode {
  /** Nested structures, in source order. */
  readonly children: readonly SourceNode[];
  /** Last row the node covers, 0-indexed and inclusive. */
  readonly endRow: number;
  /** First row the node covers, 0-indexed and inclusive. */
  readonly startRow: number;
  /** Node kind, spelled as the parser spells it: `comment`, `block`. */
  readonly type: string;
}

/** A node still being built, so a parser can attach children as it finds them. */
interface MutableNode {
  children: MutableNode[];
  endRow: number;
  startRow: number;
  type: string;
}

/**
 * Turns source into the node shape the walk needs.
 *
 * `undefined` means "no summary for this file" — an unsupported language, or a
 * parse that failed. It never means "empty file".
 */
export type SourceParser = (
  source: string,
  filePath: string
) => SourceNode | undefined;

/** A body collapsed to a marker, 1-indexed and inclusive. */
export interface ElidedRange {
  /** Last line hidden by the marker. */
  endLine: number;
  /** First line hidden by the marker. */
  startLine: number;
}

export interface StructuralSummary {
  /** True when the summary hit its line bound and the file's tail is elided. */
  capped: boolean;
  /** The summary text: numbered lines, with an elided body marked in place. */
  content: string;
  /** Lines hidden behind markers, over all elided ranges. */
  elidedLines: number;
  /** The ranges elided in this summary, ascending and non-overlapping. */
  elidedRanges: ElidedRange[];
  /**
   * Body-like nodes left verbatim because their interior was shorter than
   * `MIN_BODY_LINES`, so collapsing them would cost more than it saved.
   */
  keptBodies: number;
}

export interface SummarizeOptions {
  /**
   * Parser override.
   *
   * A caller that already has a tree passes one here; so does a test that must
   * not depend on which grammar packages happen to be installed.
   */
  parse?: SourceParser | undefined;
}

/** A line span found while scanning, 0-indexed and inclusive. */
interface RowSpan {
  readonly endRow: number;
  readonly startRow: number;
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Grammar package per extension, spelled as spectra resolves them.
 *
 * The packages are native addons that ship no usable types, so they are loaded
 * through `require` and narrowed by hand. Loading is optional: a missing grammar
 * falls back to the built-in scanner rather than failing the read.
 */
const GRAMMAR_BY_EXTENSION: Record<string, string> = {
  ".bash": "tree-sitter-bash",
  ".c": "tree-sitter-c",
  ".cc": "tree-sitter-cpp",
  ".cpp": "tree-sitter-cpp",
  ".cs": "tree-sitter-c-sharp",
  ".css": "tree-sitter-css",
  ".go": "tree-sitter-go",
  ".h": "tree-sitter-c",
  ".html": "tree-sitter-html",
  ".java": "tree-sitter-java",
  ".js": "tree-sitter-javascript",
  ".json": "tree-sitter-json",
  ".jsx": "tree-sitter-javascript",
  ".php": "tree-sitter-php",
  ".py": "tree-sitter-python",
  ".rb": "tree-sitter-ruby",
  ".rs": "tree-sitter-rust",
  ".sh": "tree-sitter-bash",
  ".sql": "tree-sitter-sql",
  ".ts": "tree-sitter-typescript",
  ".tsx": "tree-sitter-typescript",
};

/** Extensions the built-in brace scanner understands. */
const BRACE_EXTENSIONS: Record<string, true> = {
  ".c": true,
  ".cc": true,
  ".cpp": true,
  ".cs": true,
  ".css": true,
  ".go": true,
  ".h": true,
  ".java": true,
  ".js": true,
  ".json": true,
  ".jsx": true,
  ".php": true,
  ".rs": true,
  ".ts": true,
  ".tsx": true,
};

/**
 * Kind reported for each opening delimiter of the built-in scanner.
 *
 * `block` covers a `{…}` body generally. Naming every one of them
 * `statement_block` would claim a precision this scanner does not have — it
 * cannot tell a function body from a class body — and the walk only asks whether
 * a kind holds a body.
 */
const BLOCK_TYPES: Record<string, string> = {
  "(": "argument_list",
  "[": "array",
  "{": "block",
};

/** The opening delimiter each closer belongs to. */
const MATCHING_OPENERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** Characters after which a `/` opens a regex literal rather than a division. */
const REGEX_PRECEDING_CHARS = "(,=:[!&|?{};+-*%^~<>";

/** Words after which a `/` opens a regex literal rather than a division. */
const REGEX_PRECEDING_WORD_RE =
  /^(?:await|case|delete|do|else|in|instanceof|new|of|return|typeof|void|yield)$/;

/** Word characters, for tracking the token a `/` follows. */
const WORD_CHARACTER_RE = /[A-Za-z0-9_$]/;

/** Whitespace inside a line, which never decides whether a `/` is a regex. */
const INSIGNIFICANT_RE = /[ \t\r]/;

/** Where the scanner is while masking strings and comments. */
type ScanMode =
  | "blockComment"
  | "code"
  | "doubleQuote"
  | "lineComment"
  | "regex"
  | "singleQuote"
  | "template";

interface MaskedSource {
  /** Rows of each `/* … *\/` block, in source order. */
  comments: RowSpan[];
  /** The source with string and comment bodies blanked, line for line. */
  lines: string[];
}

/** A row inside a tree-sitter node position. */
interface RowPosition {
  row: number;
}

/** Tree-sitter's node, narrowed down to the fields the walk reads. */
interface NativeNode {
  child: (index: number) => NativeNode | null;
  childCount: number;
  endPosition: RowPosition;
  hasError: boolean;
  startPosition: RowPosition;
  type: string;
}

/** Tree-sitter's parser, narrowed down to the calls needed here. */
interface NativeParser {
  parse: (source: string) => unknown;
  setLanguage: (language: unknown) => void;
}

/** The constructor shape the tree-sitter addon exports. */
type NativeParserConstructor = new () => NativeParser;

/** True when a value is a tree-sitter point: an object carrying a numeric row. */
function isRowPosition(value: unknown): value is RowPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    "row" in value &&
    typeof value.row === "number"
  );
}

/**
 * True when a value has the fields the walk reads from a tree-sitter node.
 *
 * The addon ships no types to import, so the shape is proven here rather than
 * asserted: every field the walk touches is checked, and nothing else is read.
 */
function isNativeNode(value: unknown): value is NativeNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("type" in value) || typeof value.type !== "string") {
    return false;
  }

  if (!("childCount" in value) || typeof value.childCount !== "number") {
    return false;
  }

  if (!("child" in value) || typeof value.child !== "function") {
    return false;
  }

  if (!("hasError" in value) || typeof value.hasError !== "boolean") {
    return false;
  }

  const endPosition = "endPosition" in value ? value.endPosition : undefined;

  if (!isRowPosition(endPosition)) {
    return false;
  }

  const startPosition =
    "startPosition" in value ? value.startPosition : undefined;

  return isRowPosition(startPosition);
}

/**
 * The language object inside a grammar package.
 *
 * TypeScript and PHP ship several languages in one package, so those two are
 * selected rather than unwrapped, matching how spectra loads them.
 */
function selectLanguage(
  packageName: string,
  extension: string,
  grammar: unknown
): unknown {
  if (typeof grammar !== "object" || grammar === null) {
    return undefined;
  }

  if (packageName === "tree-sitter-typescript") {
    if (extension === ".tsx" && "tsx" in grammar) {
      return grammar.tsx;
    }
    return "typescript" in grammar ? grammar.typescript : undefined;
  }

  if (packageName === "tree-sitter-php" && "php" in grammar) {
    return grammar.php;
  }

  return "default" in grammar ? grammar.default : grammar;
}

/**
 * Load the tree-sitter parser and grammar for a path.
 *
 * `undefined` for an extension with no grammar, for packages that are not
 * installed, and for a package whose shape is not what this expects. Every one
 * of those is a fallback, not an error: the caller still gets a summary from the
 * built-in scanner.
 */
function loadTreeSitter(
  filePath: string
): { language: unknown; parser: NativeParser } | undefined {
  const extension = extname(filePath).toLowerCase();
  const packageName = GRAMMAR_BY_EXTENSION[extension];

  if (packageName === undefined) {
    return undefined;
  }

  try {
    const language = selectLanguage(
      packageName,
      extension,
      nodeRequire(packageName)
    );
    const parserModule = nodeRequire("tree-sitter");
    const parserExport =
      typeof parserModule === "object" &&
      parserModule !== null &&
      "default" in parserModule
        ? parserModule.default
        : parserModule;

    if (language === undefined || typeof parserExport !== "function") {
      return undefined;
    }

    // The addon ships no types to import, and the check above is the only
    // evidence available that this callable is tree-sitter's parser.
    const parser = new (parserExport as NativeParserConstructor)();
    parser.setLanguage(language);

    return { language, parser };
  } catch {
    return undefined;
  }
}

/** Convert a native subtree into the shape the walk reads. */
function toSourceNode(node: NativeNode): SourceNode {
  const children: SourceNode[] = [];

  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && isNativeNode(child)) {
      children.push(toSourceNode(child));
    }
  }

  return {
    children,
    endRow: node.endPosition.row,
    startRow: node.startPosition.row,
    type: node.type,
  };
}

/**
 * Parse with tree-sitter, or `undefined`.
 *
 * A tree with syntax errors is refused outright, exactly as spectra refuses it:
 * the ranges a half-parsed tree reports are guesses, and a summary that elides
 * the wrong lines is worse than no summary. An errored parse is therefore not a
 * fallback case — the file is rendered in full instead.
 */
function parseWithTreeSitter(
  parser: NativeParser,
  source: string
): SourceNode | undefined {
  const tree = parser.parse(source);
  const root =
    typeof tree === "object" && tree !== null && "rootNode" in tree
      ? tree.rootNode
      : undefined;

  if (!(isNativeNode(root) && !root.hasError)) {
    return undefined;
  }

  return toSourceNode(root);
}

/** What the scanner carries from character to character and line to line. */
interface MaskCursor {
  characters: readonly string[];
  column: number;
  commentStartRow: number;
  comments: RowSpan[];
  inCharacterClass: boolean;
  lastWord: string;
  mode: ScanMode;
  output: string[];
  previousSignificant: string;
  row: number;
}

/** Quote characters that open a string, and the mode each one enters. */
const QUOTE_MODES: Record<string, ScanMode> = {
  "'": "singleQuote",
  '"': "doubleQuote",
  "`": "template",
};

/** True when a `/` at this point opens a regex literal. */
function regexCanStart(previousSignificant: string, lastWord: string): boolean {
  if (previousSignificant === "") {
    return true;
  }

  return (
    REGEX_PRECEDING_WORD_RE.test(lastWord) ||
    REGEX_PRECEDING_CHARS.includes(previousSignificant)
  );
}

/** Blank one character of a line comment: it runs to the end of the line. */
function maskLineComment(cursor: MaskCursor): void {
  cursor.output[cursor.column] = " ";
  cursor.column += 1;
}

/** Blank characters until a block comment closes. */
function maskBlockComment(cursor: MaskCursor): void {
  const character = cursor.characters[cursor.column] ?? "";
  const next = cursor.characters[cursor.column + 1] ?? "";

  cursor.output[cursor.column] = " ";
  cursor.column += 1;

  if (character === "*" && next === "/") {
    cursor.output[cursor.column] = " ";
    cursor.column += 1;
    cursor.mode = "code";
    cursor.comments.push({
      endRow: cursor.row,
      startRow: cursor.commentStartRow,
    });
  }
}

/** Blank characters inside a string or template until it closes. */
function maskQuoted(cursor: MaskCursor): void {
  const character = cursor.characters[cursor.column] ?? "";

  cursor.output[cursor.column] = " ";
  cursor.column += 1;

  if (character === "\\") {
    cursor.output[cursor.column] = " ";
    cursor.column += 1;
    return;
  }

  const closes =
    (cursor.mode === "singleQuote" && character === "'") ||
    (cursor.mode === "doubleQuote" && character === '"') ||
    (cursor.mode === "template" && character === "`");

  if (closes) {
    cursor.mode = "code";
  }
}

/** Blank characters until a regex literal closes. */
function maskRegex(cursor: MaskCursor): void {
  const character = cursor.characters[cursor.column] ?? "";

  cursor.output[cursor.column] = " ";
  cursor.column += 1;

  if (character === "\\") {
    cursor.output[cursor.column] = " ";
    cursor.column += 1;
    return;
  }

  if (character === "[") {
    cursor.inCharacterClass = true;
    return;
  }

  if (character === "]") {
    cursor.inCharacterClass = false;
    return;
  }

  if (character === "/" && !cursor.inCharacterClass) {
    cursor.mode = "code";
    cursor.inCharacterClass = false;
  }
}

/** Open the construct the character starts, or track it as ordinary code. */
function maskCode(cursor: MaskCursor): void {
  const character = cursor.characters[cursor.column] ?? "";
  const next = cursor.characters[cursor.column + 1] ?? "";

  if (character === "/" && next === "/") {
    cursor.output[cursor.column] = " ";
    cursor.output[cursor.column + 1] = " ";
    cursor.column += 2;
    cursor.mode = "lineComment";
    return;
  }

  if (character === "/" && next === "*") {
    cursor.output[cursor.column] = " ";
    cursor.output[cursor.column + 1] = " ";
    cursor.column += 2;
    cursor.mode = "blockComment";
    cursor.commentStartRow = cursor.row;
    return;
  }

  const quoteMode = QUOTE_MODES[character];

  if (quoteMode !== undefined) {
    cursor.output[cursor.column] = " ";
    cursor.column += 1;
    cursor.mode = quoteMode;
    cursor.previousSignificant = "";
    cursor.lastWord = "";
    return;
  }

  if (
    character === "/" &&
    regexCanStart(cursor.previousSignificant, cursor.lastWord)
  ) {
    cursor.output[cursor.column] = " ";
    cursor.column += 1;
    cursor.mode = "regex";
    return;
  }

  cursor.column += 1;

  if (INSIGNIFICANT_RE.test(character)) {
    return;
  }

  cursor.previousSignificant = character;
  cursor.lastWord = WORD_CHARACTER_RE.test(character)
    ? cursor.lastWord + character
    : "";
}

/** One masking step per scanner mode. */
const MASK_HANDLERS: Record<ScanMode, (cursor: MaskCursor) => void> = {
  blockComment: maskBlockComment,
  code: maskCode,
  doubleQuote: maskQuoted,
  lineComment: maskLineComment,
  regex: maskRegex,
  singleQuote: maskQuoted,
  template: maskQuoted,
};

/**
 * Reset the modes that cannot span a line.
 *
 * None of them may cross a line boundary in the languages scanned here, so an
 * unterminated one is a bad guess about where the construct started. Resetting
 * keeps one stray quote from masking the rest of the file.
 */
function resetUnterminated(cursor: MaskCursor): void {
  if (
    cursor.mode === "lineComment" ||
    cursor.mode === "singleQuote" ||
    cursor.mode === "doubleQuote" ||
    cursor.mode === "regex"
  ) {
    cursor.mode = "code";
    cursor.previousSignificant = "";
    cursor.lastWord = "";
  }
}

/**
 * Blank string and comment bodies, keeping every position.
 *
 * The scanner below must not see a brace inside a string, a regex, or a comment,
 * and the walk must not see masked characters as content — so the mask replaces
 * those characters with spaces rather than removing them. Regex tracking is
 * needed for the same reason: `/[}]/` and `a / b` look alike until the character
 * before the slash is taken into account.
 */
function maskSource(lines: readonly string[]): MaskedSource {
  const cursor: MaskCursor = {
    characters: [],
    column: 0,
    commentStartRow: 0,
    comments: [],
    inCharacterClass: false,
    lastWord: "",
    mode: "code",
    output: [],
    previousSignificant: "",
    row: 0,
  };
  const masked: string[] = [];

  for (const [row, line] of lines.entries()) {
    cursor.characters = line.split("");
    cursor.output = [...cursor.characters];
    cursor.column = 0;
    cursor.row = row;

    while (cursor.column < cursor.characters.length) {
      MASK_HANDLERS[cursor.mode](cursor);
    }

    masked.push(cursor.output.join(""));
    resetUnterminated(cursor);
  }

  return { comments: cursor.comments, lines: masked };
}

/** Attach a comment node to the innermost block that contains it. */
function attachComment(root: MutableNode, span: RowSpan): void {
  let parent = root;
  let descended = true;

  while (descended) {
    descended = false;

    for (const child of parent.children) {
      const contains =
        child.startRow <= span.startRow && child.endRow >= span.endRow;
      if (contains) {
        parent = child;
        descended = true;
        break;
      }
    }
  }

  parent.children.push({
    children: [],
    endRow: span.endRow,
    startRow: span.startRow,
    type: "comment",
  });
}

/**
 * Find brace-delimited bodies without a parser package.
 *
 * This is the fallback, not the port: spectra's structure comes from
 * tree-sitter. It recognises the same bodies for the brace languages by matching
 * brackets over masked source, which is enough for the elision rule, because
 * every kind that rule matches — a function body, a class body, an object
 * literal, an argument list, a block comment — is delimited by a bracket.
 *
 * It is deliberately conservative. A language whose structure is not brackets —
 * Python, Ruby, shell, SQL, HTML — returns `undefined` rather than a guess, and
 * so does a bracket the scan cannot pair, because an unpaired bracket only
 * shortens the bodies it reports and never invents one.
 */
export function parseBraceStructure(
  source: string,
  filePath: string
): SourceNode | undefined {
  if (BRACE_EXTENSIONS[extname(filePath).toLowerCase()] !== true) {
    return undefined;
  }

  const sourceLines = source.split("\n");
  const { comments, lines } = maskSource(sourceLines);
  const root: MutableNode = {
    children: [],
    endRow: sourceLines.length - 1,
    startRow: 0,
    type: "program",
  };
  const open: Array<{ node: MutableNode; opener: string }> = [
    { node: root, opener: "" },
  ];

  for (const [row, line] of lines.entries()) {
    for (const character of line) {
      const openerType = BLOCK_TYPES[character];

      if (openerType !== undefined) {
        const parent = open.at(-1);
        if (parent === undefined) {
          continue;
        }
        const node: MutableNode = {
          children: [],
          endRow: row,
          startRow: row,
          type: openerType,
        };
        parent.node.children.push(node);
        open.push({ node, opener: character });
        continue;
      }

      const expectedOpener = MATCHING_OPENERS[character];
      const innermost = open.at(-1);

      if (
        expectedOpener !== undefined &&
        open.length > 1 &&
        innermost !== undefined &&
        innermost.opener === expectedOpener
      ) {
        innermost.node.endRow = row;
        open.pop();
      }
    }
  }

  for (const span of comments) {
    attachComment(root, span);
  }

  return root;
}

/**
 * Collect the bodies worth collapsing.
 *
 * Returns how many body-like nodes were left verbatim, so the footer can say how
 * much of the structure survived. A collapsed body is not descended into: its
 * interior is already hidden, so a body nested inside it would only produce a
 * range overlapping one already found.
 */
function collectElisions(node: SourceNode, ranges: ElidedRange[]): number {
  const startLine = node.startRow + 1;
  const endLine = node.endRow + 1;
  const bodyLike = BODY_LIKE_RE.test(node.type);

  if (bodyLike && endLine - startLine - 1 >= MIN_BODY_LINES) {
    ranges.push({ endLine: endLine - 1, startLine: startLine + 1 });
    return 0;
  }

  let kept = bodyLike ? 1 : 0;

  for (const child of node.children) {
    kept += collectElisions(child, ranges);
  }

  return kept;
}

/** Keep the first range of each overlapping group, in source order. */
function nonOverlappingRanges(ranges: readonly ElidedRange[]): ElidedRange[] {
  const ordered = [...ranges].sort(
    (left, right) => left.startLine - right.startLine
  );
  const kept: ElidedRange[] = [];

  for (const range of ordered) {
    const previous = kept.at(-1);
    if (previous === undefined || range.startLine > previous.endLine) {
      kept.push(range);
    }
  }

  return kept;
}

/**
 * Render the summary text for a set of elided ranges.
 *
 * The line bound is spent first-come: kept lines are emitted in order until the
 * budget is gone, and the rest of the file becomes one more elided range. That
 * range is elided like any other, so it is named in the footer selector and
 * nothing is lost to the bound.
 */
function renderSummary(
  lines: readonly string[],
  filePath: string,
  ranges: readonly ElidedRange[],
  keptBodies: number
): StructuralSummary {
  // Gutter width matches the read tool's ranged rendering: four columns minimum.
  const width = Math.max(4, String(lines.length).length);
  const byStartLine = new Map(ranges.map((range) => [range.startLine, range]));
  const elided: ElidedRange[] = [];
  const bodyBudget = MAX_SUMMARY_LINES - 2;
  const rendered: string[] = [];
  let tail: ElidedRange | undefined;

  for (let line = 1; line <= lines.length; line += 1) {
    const range = byStartLine.get(line);

    if (range !== undefined) {
      rendered.push(
        `---- omitted lines ${range.startLine}-${range.endLine} ----`
      );
      elided.push(range);
      line = range.endLine;
      continue;
    }

    if (rendered.length >= bodyBudget) {
      tail = { endLine: lines.length, startLine: line };
      break;
    }

    rendered.push(
      `${String(line).padStart(width, " ")}| ${lines[line - 1] ?? ""}`
    );
  }

  if (tail !== undefined) {
    rendered.push(`---- omitted lines ${tail.startLine}-${tail.endLine} ----`);
    elided.push(tail);
  }

  const elidedLines = elided.reduce(
    (total, range) => total + (range.endLine - range.startLine + 1),
    0
  );
  const shown = elided.slice(0, MAX_FOOTER_SELECTORS);
  const hidden = elided.length - shown.length;
  const selectors = shown
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(",");
  const bodyNoun = elided.length === 1 ? "body" : "bodies";
  const declarationNoun = keptBodies === 1 ? "declaration" : "declarations";
  const rangeNoun = hidden === 1 ? "range" : "ranges";
  const capped =
    tail === undefined ? "" : ` summary capped at ${MAX_SUMMARY_LINES} lines;`;
  const remainder =
    hidden === 0
      ? ""
      : `; ${hidden} further ${rangeNoun} elided; read ${filePath}:1- for the whole file`;

  rendered.push(
    `[${elided.length} ${bodyNoun} elided (${elidedLines} lines); ${keptBodies} ${declarationNoun} kept verbatim;${capped} re-read required ranges with ${filePath}:${selectors}${remainder}]`
  );

  return {
    capped: tail !== undefined,
    content: rendered.join("\n"),
    elidedLines,
    elidedRanges: elided,
    keptBodies,
  };
}

/** Parse with tree-sitter when it is installed, else with the brace scanner. */
function defaultParser(
  source: string,
  filePath: string
): SourceNode | undefined {
  const native = loadTreeSitter(filePath);

  return native === undefined
    ? parseBraceStructure(source, filePath)
    : parseWithTreeSitter(native.parser, source);
}

/**
 * Summarise a source file's structure, or `undefined` when it should not be.
 *
 * Call this only for a whole-file read of a mutable text file — never beside a
 * selector, an offset, or a limit, and never for a resource a format reader
 * produced. The caller keeps the summary opt in; this function keeps it honest.
 *
 * `filePath` appears in the footer and selects the grammar, so pass the path the
 * caller would have to type to read the file back.
 */
export function summarizeSource(
  content: string,
  filePath: string,
  options: SummarizeOptions = {}
): StructuralSummary | undefined {
  const lines = content.split("\n");

  if (lines.length < MIN_SUMMARY_LINES) {
    return undefined;
  }

  const parse = options.parse ?? defaultParser;
  const root = parse(content, filePath);

  if (root === undefined) {
    return undefined;
  }

  const collected: ElidedRange[] = [];
  const keptBodies = collectElisions(root, collected);
  const ranges = nonOverlappingRanges(collected);

  if (ranges.length === 0) {
    return undefined;
  }

  return renderSummary(lines, filePath, ranges, keptBodies);
}
