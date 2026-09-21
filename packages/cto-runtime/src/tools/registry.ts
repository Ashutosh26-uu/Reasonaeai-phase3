/**
 * The tool registry.
 *
 * Every tool the runtime can expose is described once, here, with the facts other
 * layers need to reason about it: whether it mutates state, whether it reaches
 * outside the sandbox, and how it is addressed. Everything else is derived from
 * those facts rather than restated.
 *
 * That derivation is the point. A hand-maintained list of "the tools that can
 * write" is wrong the moment someone adds a tool and forgets the list, and its
 * failure is silent: an agent that should have been read-only quietly keeps the
 * ability to edit. Deriving the classification from each tool's own declaration
 * means a new mutating tool is classified correctly by construction.
 *
 * The canonical name list is the compatibility contract. Models emit tool names
 * from memory and from other harnesses, so `search` and `find` resolve to `grep`
 * and `glob` instead of failing as unknown.
 */

/** What a tool does to the world, which decides what may hold it. */
export type ToolAccess =
  /** Reads state without changing it. */
  | "read"
  /** Changes workspace or durable state. */
  | "write"
  /** Runs a process or command. */
  | "execute"
  /** Delegates work to another agent. */
  | "delegate"
  /** Reads external network resources. */
  | "network";

/** Which surface a tool belongs to, for prompt grouping and eligibility. */
export type ToolSurface = "workspace" | "resource" | "delegation" | "control";

/** One registered tool. */
export interface ToolRegistration {
  /** The kinds of effect this tool can have. */
  access: readonly ToolAccess[];
  /** One-sentence description, used verbatim in the prompt inventory. */
  description: string;
  /** Usage rules the model must follow, rendered under the tool in the prompt. */
  guidance?: readonly string[] | undefined;
  /** Canonical name the model must use. */
  name: string;
  /**
   * Whether the tool's output may exceed the inline limit and be spilled to an
   * artifact. Tools that return unbounded output set this so the run does not
   * lose the tail.
   */
  spilling?: boolean | undefined;
  surface: ToolSurface;
}

/**
 * The canonical built-in tool names.
 *
 * This list is the contract, not a wish list: a name appears here only once the
 * tool exists. A name that is listed but unimplemented would appear in the
 * prompt inventory as available and then fail when called, which is worse than
 * omitting it.
 */
export const BUILTIN_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "task",
  "todo",
  "web_fetch",
  "ask",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * Names other harnesses and older versions use for the same tool.
 *
 * A model trained on another agent will reach for `search` when it means `grep`.
 * Resolving the alias keeps that call working instead of spending a turn on an
 * unknown-tool error.
 */
const LEGACY_TOOL_ALIASES: Readonly<Record<string, BuiltinToolName>> = {
  execute: "bash",
  fetch: "web_fetch",
  find: "glob",
  search: "grep",
  shell: "bash",
  spawn: "task",
  todo_write: "todo",
  todowrite: "todo",
  webfetch: "web_fetch",
};

/** Resolve a name to its canonical form. Unknown names are returned lowercased. */
export function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return LEGACY_TOOL_ALIASES[normalized] ?? normalized;
}

/** Normalize and deduplicate names, preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const normalized = normalizeToolName(name);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

/**
 * The registry's tool descriptions.
 *
 * `access` is what makes the rest of the system safe: a read-only agent is one
 * whose definition excludes every tool declaring `write` or `execute`, and
 * nothing has to remember that a particular tool happens to mutate files.
 */
const REGISTRATIONS: readonly ToolRegistration[] = [
  {
    access: ["read"],
    description:
      "Read a file, a directory listing, or a resource URL, optionally a line range. Returns line-numbered content.",
    guidance: [
      "Append `:N-M` for a line range, `:N+K` for a window, `:N-` for the tail, `:raw` for unnumbered content, or `:conflicts` for unresolved merge conflicts.",
      "Read a resource URL such as `docs://` or `artifact://<id>` through this same tool.",
    ],
    name: "read",
    spilling: true,
    surface: "workspace",
  },
  {
    access: ["write"],
    description: "Create or replace a whole file.",
    guidance: [
      "Prefer `edit` for a change to an existing file: replacing a file discards content you did not intend to touch.",
    ],
    name: "write",
    surface: "workspace",
  },
  {
    access: ["write"],
    description:
      "Change part of an existing file by replacing a matched region.",
    guidance: [
      "Read the target first: an edit is applied against the content you were shown.",
    ],
    name: "edit",
    surface: "workspace",
  },
  {
    access: ["read"],
    description: "List paths matching a glob pattern.",
    name: "glob",
    spilling: true,
    surface: "workspace",
  },
  {
    access: ["read"],
    description:
      "Search file contents with a regular expression, optionally scoped to paths or globs.",
    name: "grep",
    spilling: true,
    surface: "workspace",
  },
  {
    access: ["execute"],
    description:
      "Run a shell command and return its stdout, stderr, and exit code.",
    guidance: [
      "Prefer the dedicated tools over shell equivalents for reading, searching, and editing files.",
      "Do not use a command that waits for input; there is no interactive terminal.",
    ],
    name: "bash",
    spilling: true,
    surface: "workspace",
  },
  {
    access: ["delegate"],
    description:
      "Delegate a bounded objective to another agent and return its result.",
    guidance: [
      "Give the worker every fact it needs: it does not see this conversation.",
      "State the objective and the evidence you expect back.",
    ],
    name: "task",
    surface: "delegation",
  },
  {
    access: ["read", "write"],
    description: "Record and update the plan as a structured task list.",
    name: "todo",
    surface: "control",
  },
  {
    access: ["read", "network"],
    description: "Read a web URL and return its main content as text.",
    name: "web_fetch",
    spilling: true,
    surface: "resource",
  },
  {
    access: ["read"],
    description: "Ask the user a question and wait for the answer.",
    guidance: [
      "Use only for a decision the run cannot resolve from the workspace or its own policy.",
    ],
    name: "ask",
    surface: "control",
  },
];

export class ToolRegistry {
  readonly #registrations: ReadonlyMap<string, ToolRegistration>;

  constructor(registrations: readonly ToolRegistration[] = REGISTRATIONS) {
    this.#registrations = new Map(
      registrations.map((registration) => [
        normalizeToolName(registration.name),
        registration,
      ])
    );
  }

  /** The registration for a canonical or aliased name. */
  get(name: string): ToolRegistration | undefined {
    return this.#registrations.get(normalizeToolName(name));
  }

  /** Every registration, in canonical name order. */
  all(): ToolRegistration[] {
    return [...this.#registrations.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  /** Every canonical name, for validating a definition's tool list. */
  names(): string[] {
    return this.all().map((registration) => registration.name);
  }

  /**
   * Names whose declared access is entirely within `permitted`.
   *
   * This is what makes a read-only agent read-only: it is the set of tools that
   * cannot mutate anything, computed from declarations rather than asserted.
   */
  namesWithin(permitted: readonly ToolAccess[]): string[] {
    const allowed = new Set(permitted);
    return this.all()
      .filter((registration) =>
        registration.access.every((entry) => allowed.has(entry))
      )
      .map((registration) => registration.name);
  }

  /**
   * Names that can change state, run a command, or reach the network.
   *
   * Derived, so adding a mutating tool to the registry classifies it correctly
   * without any other file being updated.
   */
  mutatingNames(): string[] {
    return this.all()
      .filter((registration) =>
        registration.access.some(
          (entry) =>
            entry === "write" || entry === "execute" || entry === "network"
        )
      )
      .map((registration) => registration.name);
  }

  /**
   * Name the caller most likely meant, given an unknown one.
   *
   * A prefix or substring relationship is a strong signal: `reading` and
   * `read_file` both point at `read`. Returning nothing is correct when nothing
   * is close, because a bad suggestion is worse than none.
   */
  suggest(name: string): string | undefined {
    const target = normalizeToolName(name);

    const byPrefix = this.names().filter(
      (candidate) =>
        candidate.startsWith(target) || target.startsWith(candidate)
    );
    if (byPrefix.length > 0) {
      return byPrefix[0];
    }

    const bySubstring = this.names().filter((candidate) =>
      candidate.includes(target)
    );
    return bySubstring[0];
  }

  /**
   * Which of the supplied names are unknown, each with its best suggestion.
   *
   * An unknown tool in an agent definition is a definition the author did not
   * intend: the agent either cannot do part of its job, or a denylist entry
   * protects nothing.
   */
  diagnose(
    names: readonly string[]
  ): { name: string; suggestion?: string | undefined }[] {
    const problems: { name: string; suggestion?: string | undefined }[] = [];

    for (const name of names) {
      if (this.get(name) === undefined) {
        problems.push({ name, suggestion: this.suggest(name) });
      }
    }

    return problems;
  }
}

/** The process-wide registry, built once from the canonical registrations. */
export const toolRegistry = new ToolRegistry();
