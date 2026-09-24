/**
 * Agent definition and catalog types.
 *
 * Mirrors the agent system in Spectra: one `AgentDefinition` interface for every
 * agent, an `AgentCatalog` built from definitions, and `AgentDiagnostic` entries
 * so a malformed user-authored file is reported rather than silently dropped.
 *
 * Two fields are deliberate additions beyond that shape, both from oh-my-pi:
 * `spawns`, which bounds which agents an agent may reach, and `blocking`, which
 * tells the runtime whether a delegation returns inline or runs in the
 * background.
 */

export type AgentMode = "primary" | "subagent" | "all";

export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Structured handoff schema. An opaque JSON-compatible tree. */
export type AgentOutputSchema = Record<string, unknown>;

export interface AgentDefinition {
  /**
   * Whether a delegation to this agent returns inline (`true`) or runs in the
   * background (`false`). A read-only investigator is normally inline.
   */
  blocking?: boolean | undefined;
  /** Prompt-bar accent colour: hex (`#RRGGBB`) or a named token. */
  color?: string | undefined;
  description: string;
  /** Denylist, applied after the allowlist when one is present. */
  disallowedTools?: string[] | undefined;
  /** Hidden agents are not offered for selection. */
  hidden?: boolean | undefined;
  /** Optional hard step cap. Omitted means no cap. */
  maxTurns?: number | undefined;
  /**
   * Extension bag for values this contract does not model. Keeps a project or
   * future feature from forcing a new field onto every definition, and keeps
   * tooling-only values out of the typed surface. Never interpreted by the
   * runtime core.
   */
  metadata?: Record<string, unknown> | undefined;
  mode: AgentMode;
  model?: { id: string; provider: string } | undefined;
  name: string;
  output?: AgentOutputSchema | undefined;
  /** The agent's system prompt. */
  prompt: string;
  /** Prefer summarised file reads, for agents that scan broadly. */
  readSummarize?: boolean | undefined;
  /** Reporting instructions appended to a delegation prompt. */
  reporting?: string | undefined;
  /** Absolute path when loaded from markdown. */
  source?: string | undefined;
  /**
   * Which agents this agent may reach. `"*"` allows any resolvable agent; an
   * array allowlists by exact name. Omitted means the agent cannot delegate at
   * all, which is the safe default.
   */
  spawns?: "*" | string[] | undefined;
  temperature?: number | undefined;
  thinkingLevel?: AgentThinkingLevel | undefined;
  /**
   * Allowlist. When set, only these tools are available, then `disallowedTools`
   * is subtracted. When omitted, every permitted tool is inherited.
   */
  tools?: string[] | undefined;
}

export interface AgentDiagnostic {
  kind: "parse" | "validation";
  message: string;
  sourcePath: string;
}

export interface AgentCatalog {
  definitions: Record<string, AgentDefinition>;
  diagnostics: AgentDiagnostic[];
  primary: string[];
  subagents: string[];
}
