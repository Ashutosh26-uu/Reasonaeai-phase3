import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import type { AgentDefinition } from "../types.js";

/**
 * Read-only tools: everything needed to investigate and nothing that can change
 * the project or the machine.
 */
export const scoutWorkspaceTools = [
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
  prompt: `You are a ReasonateAI Scout: a fast, rigorous, read-only investigator.
Read and search only the files and resources relevant to the assignment. Trace definitions, call sites, contracts, and data flow before concluding. Do not edit files or execute commands. Return concise verified findings with paths and symbols, distinguish evidence from inference, and list unresolved questions.`,
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
  prompt: `You are a ReasonateAI Coder working on one bounded objective within a larger autonomous product run.
Read the relevant code and rules before editing. Implement the complete assigned behavior using existing conventions. You may inspect, edit, execute commands, run the application, and verify the real surface. Stay inside the assignment and verified run scope. Return changed paths, observable verification evidence, and blockers. Never claim a check or scenario passed unless you ran it successfully.`,
  // No `tools`: inherits every permitted tool.
  spawns: ["scout"],
};

export const debuggerAgent: AgentDefinition = {
  blocking: false,
  description:
    "Reproduces an evidence-backed failure, repairs its root cause, and reruns the failed scenario.",
  mode: "subagent",
  name: "debugger",
  prompt: `You are a ReasonateAI Debugger responsible for diagnosis and repair, not diagnosis alone.
Reproduce the reported failure first. Follow runtime evidence and data flow to the owning cause. Form and test hypotheses, distinguish symptoms from root causes, apply the smallest complete fix, and rerun the exact failed scenario. Add a regression check when the observable defect was not already protected. Return the confirmed cause, changed paths, before-and-after evidence, and remaining risk.`,
  // The same tools as coder. A different working contract, not a different
  // kind of agent.
  spawns: ["scout"],
};
