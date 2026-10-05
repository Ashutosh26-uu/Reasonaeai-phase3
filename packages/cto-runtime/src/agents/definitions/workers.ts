import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import {
  CODER_INSTRUCTIONS,
  DEBUGGER_INSTRUCTIONS,
  REVIEWER_INSTRUCTIONS,
  SCOUT_INSTRUCTIONS,
} from "../../prompts.js";
import type { AgentDefinition } from "../types.js";

/**
 * Read-only tools: everything needed to investigate and nothing that can change
 * the project or the machine.
 */
export const scoutWorkspaceTools = [
  "read",
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  WORKSPACE_TOOLS.LSP.LSP_INSPECT,
] as const;

/**
 * Tools that write, mutate, or execute. An agent holding any of these is not
 * read-only, which is what `read-only` means in this system: a tool set, not a
 * kind of agent.
 */
export const writeCapableTools = [
  "edit",
  "write",
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  ...Object.values(WORKSPACE_TOOLS.SANDBOX),
  ...Object.values(WORKSPACE_TOOLS.COMPUTER),
];

/** Every tool the deployment permits an agent to hold. */
export const reasonateToolUniverse: string[] = [
  "read",
  "edit",
  "write",
  ...Object.values(WORKSPACE_TOOLS.FILESYSTEM),
  ...Object.values(WORKSPACE_TOOLS.SANDBOX),
  ...Object.values(WORKSPACE_TOOLS.COMPUTER),
  ...Object.values(WORKSPACE_TOOLS.SEARCH),
  ...Object.values(WORKSPACE_TOOLS.LSP),
];

/** Retained name: the full surface, for callers that need every tool. */
export const fullWorkspaceTools = reasonateToolUniverse;

export const scoutAgent: AgentDefinition = {
  blocking: true,
  description:
    "Investigates a focused question through read-only file, search, and language-intelligence tools.",
  mode: "subagent",
  name: "scout",
  prompt: SCOUT_INSTRUCTIONS,
  // An allowlist rather than a denylist: a read-only guarantee should fail
  // closed when a new tool is added rather than inherit it.
  tools: [...scoutWorkspaceTools],
};

export const coderAgent: AgentDefinition = {
  blocking: false,
  description:
    "Implements and verifies one bounded product objective with the full workspace and execution surface.",
  mode: "subagent",
  name: "coder",
  prompt: CODER_INSTRUCTIONS,
  // No `tools`: inherits every permitted tool.
  spawns: ["scout"],
};

export const debuggerAgent: AgentDefinition = {
  blocking: false,
  description:
    "Reproduces an evidence-backed failure, repairs its root cause, and reruns the failed scenario.",
  mode: "subagent",
  name: "debugger",
  prompt: DEBUGGER_INSTRUCTIONS,
  // The same tools as coder. A different working contract, not a different
  // kind of agent.
  spawns: ["scout"],
};

/** Check execution can write caches/output; this agent is verification-capable, not read-only. */
export const reviewerAgent: AgentDefinition = {
  blocking: true,
  description:
    "Independently reviews a coherent change for mistakes and exploitable security flaws; runs applicable check-mode quality and runtime checks.",
  mode: "subagent",
  name: "reviewer",
  prompt: REVIEWER_INSTRUCTIONS,
  tools: [...scoutWorkspaceTools, WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND],
};
