import type {
  AgentDiagnostic,
  AgentMode,
  AgentOutputSchema,
  AgentThinkingLevel,
} from "./types.js";

export interface AgentFrontmatter {
  blocking?: boolean;
  color?: string;
  description?: string;
  disallowedTools?: string[];
  hidden?: boolean;
  maxTurns?: number;
  mode?: AgentMode;
  model?: string;
  name?: string;
  output?: AgentOutputSchema;
  readSummarize?: boolean;
  reporting?: string;
  spawns?: "*" | string[];
  temperature?: number;
  thinkingLevel?: AgentThinkingLevel;
  tools?: string[];
}

export interface ParseAgentFrontmatterResult {
  body: string;
  diagnostics: AgentDiagnostic[];
  frontmatter: AgentFrontmatter | null;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const OUTPUT_BLOCK_PATTERN = /^output\s*:\s*\|?\s*$/i;

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const MODES: readonly string[] = ["primary", "subagent", "all"];

/**
 * Field aliases. Kebab, snake, and camel spellings all resolve to one key, so an
 * author never has to remember which convention this harness chose.
 */
const FIELD_ALIASES: Record<string, string> = {
  blocking: "blocking",
  color: "color",
  description: "description",
  disallowed_tools: "disallowedTools",
  "disallowed-tools": "disallowedTools",
  disallowedtools: "disallowedTools",
  hidden: "hidden",
  max_turns: "maxTurns",
  "max-turns": "maxTurns",
  maxturns: "maxTurns",
  mode: "mode",
  model: "model",
  name: "name",
  output: "output",
  read_summarize: "readSummarize",
  "read-summarize": "readSummarize",
  readsummarize: "readSummarize",
  reporting: "reporting",
  spawns: "spawns",
  temperature: "temperature",
  thinking_level: "thinkingLevel",
  "thinking-level": "thinkingLevel",
  thinkinglevel: "thinkingLevel",
  tools: "tools",
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

export function parseStringList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed.replaceAll("'", '"'));
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry).trim()).filter(Boolean);
      }
    } catch {
      // Fall through to bracket splitting.
    }
    if (trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((entry) => stripQuotes(entry))
        .filter(Boolean);
    }
  }

  return trimmed
    .split(",")
    .map((entry) => stripQuotes(entry))
    .filter(Boolean);
}

function parseBool(raw: string): boolean | undefined {
  const trimmed = stripQuotes(raw).toLowerCase();
  if (trimmed === "true" || trimmed === "yes" || trimmed === "1") {
    return true;
  }
  if (trimmed === "false" || trimmed === "no" || trimmed === "0") {
    return false;
  }
  return undefined;
}

function parseNumber(raw: string): number | undefined {
  const value = Number(stripQuotes(raw));
  return Number.isFinite(value) ? value : undefined;
}

interface HeaderEntry {
  key: string;
  value: string;
}

/** A line that ends an indented block: non-blank and not indented. */
function isBlockBoundary(line: string): boolean {
  return line.trim().length > 0 && !line.startsWith(" ");
}

/**
 * Splits the frontmatter block into key/value entries.
 *
 * Scanning is separated from interpretation: this function knows only about
 * lines and the one nested block, and each field is applied elsewhere. That keeps
 * both halves small enough to reason about and to lint.
 */
function readHeaderEntries(block: string): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  const lines = block.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    index += 1;

    if (!(line && !line.startsWith("#"))) {
      continue;
    }

    if (OUTPUT_BLOCK_PATTERN.test(line)) {
      const nested: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (isBlockBoundary(next)) {
          break;
        }
        nested.push(next);
        index += 1;
      }
      entries.push({ key: "output", value: nested.join("\n").trim() });
      continue;
    }

    const colon = line.indexOf(":");
    if (colon < 1) {
      entries.push({ key: "", value: line });
      continue;
    }

    entries.push({
      key: line.slice(0, colon).trim(),
      value: line.slice(colon + 1).trim(),
    });
  }

  return entries;
}

interface ApplyContext {
  diagnostics: AgentDiagnostic[];
  sourcePath: string;
}

type FieldApplier = (
  frontmatter: AgentFrontmatter,
  value: string,
  context: ApplyContext
) => void;

function applyEnumField(
  frontmatter: AgentFrontmatter,
  value: string,
  context: ApplyContext,
  field: "mode" | "thinkingLevel"
): void {
  const normalized = stripQuotes(value).toLowerCase();
  const allowed = field === "mode" ? MODES : THINKING_LEVELS;

  if (!allowed.includes(normalized)) {
    context.diagnostics.push({
      kind: "validation",
      message: `Invalid ${field} "${value}"`,
      sourcePath: context.sourcePath,
    });
    return;
  }

  if (field === "mode") {
    frontmatter.mode = normalized as AgentMode;
  } else {
    frontmatter.thinkingLevel = normalized as AgentThinkingLevel;
  }
}

function applyOutput(frontmatter: AgentFrontmatter, value: string): void {
  if (!value) {
    return;
  }
  try {
    frontmatter.output = JSON.parse(value) as AgentOutputSchema;
  } catch {
    // An indented block that is not JSON is preserved verbatim rather than
    // dropped: the contract treats the schema as opaque.
    frontmatter.output = { _yaml: value };
  }
}

const FIELD_APPLIERS: Record<string, FieldApplier> = {
  blocking: (frontmatter, value) => {
    const parsed = parseBool(value);
    if (parsed !== undefined) {
      frontmatter.blocking = parsed;
    }
  },
  color: (frontmatter, value) => {
    frontmatter.color = stripQuotes(value);
  },
  description: (frontmatter, value) => {
    frontmatter.description = stripQuotes(value);
  },
  disallowedTools: (frontmatter, value) => {
    frontmatter.disallowedTools = parseStringList(value);
  },
  hidden: (frontmatter, value) => {
    const parsed = parseBool(value);
    if (parsed !== undefined) {
      frontmatter.hidden = parsed;
    }
  },
  maxTurns: (frontmatter, value) => {
    const parsed = parseNumber(value);
    if (parsed !== undefined) {
      frontmatter.maxTurns = Math.max(1, Math.floor(parsed));
    }
  },
  mode: (frontmatter, value, context) =>
    applyEnumField(frontmatter, value, context, "mode"),
  model: (frontmatter, value) => {
    frontmatter.model = stripQuotes(value);
  },
  name: (frontmatter, value) => {
    frontmatter.name = stripQuotes(value);
  },
  output: applyOutput,
  readSummarize: (frontmatter, value) => {
    const parsed = parseBool(value);
    if (parsed !== undefined) {
      frontmatter.readSummarize = parsed;
    }
  },
  reporting: (frontmatter, value) => {
    frontmatter.reporting = stripQuotes(value);
  },
  spawns: (frontmatter, value) => {
    frontmatter.spawns =
      stripQuotes(value) === "*" ? "*" : parseStringList(value);
  },
  temperature: (frontmatter, value) => {
    const parsed = parseNumber(value);
    if (parsed !== undefined) {
      frontmatter.temperature = parsed;
    }
  },
  thinkingLevel: (frontmatter, value, context) =>
    applyEnumField(frontmatter, value, context, "thinkingLevel"),
  tools: (frontmatter, value) => {
    frontmatter.tools = parseStringList(value);
  },
};

/**
 * Minimal YAML-ish frontmatter parser for agent markdown.
 *
 * Supports scalars, CSV lists, JSON arrays, and an indented `output:` block. It is
 * deliberately not a YAML implementation: an agent file needs a flat header, and
 * a full parser would accept shapes the contract cannot honour.
 */
export function parseAgentFrontmatter(
  raw: string,
  sourcePath: string
): ParseAgentFrontmatterResult {
  const diagnostics: AgentDiagnostic[] = [];
  const match: RegExpExecArray | null = FRONTMATTER_PATTERN.exec(raw);

  if (match === null) {
    return {
      body: raw.trim(),
      diagnostics: [
        {
          kind: "parse",
          message:
            "Agent file must start with a closed YAML frontmatter block (---)",
          sourcePath,
        },
      ],
      frontmatter: null,
    };
  }

  const frontmatter: AgentFrontmatter = {};
  const context: ApplyContext = { diagnostics, sourcePath };

  for (const entry of readHeaderEntries(match[1] ?? "")) {
    const key =
      FIELD_ALIASES[entry.key.toLowerCase()] ?? FIELD_ALIASES[entry.key];

    if (!key) {
      // Unknown keys are ignored so a file written for another harness still
      // loads instead of failing on fields this contract does not model.
      if (entry.key) {
        continue;
      }
      diagnostics.push({
        kind: "parse",
        message: `Invalid frontmatter line: "${entry.value}"`,
        sourcePath,
      });
      continue;
    }

    FIELD_APPLIERS[key]?.(frontmatter, entry.value, context);
  }

  return {
    body: raw.slice(match[0].length).trim(),
    diagnostics,
    frontmatter,
  };
}

/**
 * Splits a `provider/model` reference. A bare id keeps an empty provider, so a
 * deployment that routes by id alone still works.
 */
export function parseModelRef(
  model: string | undefined
): { id: string; provider: string } | undefined {
  if (!model) {
    return undefined;
  }
  const trimmed = stripQuotes(model);
  const separator = trimmed.indexOf("/");
  if (separator === -1) {
    return { id: trimmed, provider: "" };
  }
  return {
    id: trimmed.slice(separator + 1),
    provider: trimmed.slice(0, separator),
  };
}
