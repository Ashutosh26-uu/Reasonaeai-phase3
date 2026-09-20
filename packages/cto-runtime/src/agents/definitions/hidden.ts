import type { AgentDefinition } from "../types.js";

/**
 * Hidden agents.
 *
 * These are not reachable from the interface and are never offered for
 * selection, but they are ordinary definitions: the same interface, the same
 * catalog, the same resolution path. The runtime reaches them by name for work
 * the user never asks for directly. Keeping them in the same system rather than
 * in a parallel code path is the point — there is one way to describe an agent,
 * and `hidden` only decides whether it is offered.
 *
 * Both are read-only and hold no write or execute tool.
 */

export const titleAgent: AgentDefinition = {
  blocking: true,
  description: "Generates a short title for a conversation.",
  hidden: true,
  mode: "subagent",
  name: "title",
  prompt: `You name conversations.

Read the conversation you are given and reply with a title of at most eight words that names the work being done. Use the vocabulary the user used. Do not add punctuation beyond a hyphen, do not wrap the title in quotes, and do not explain your choice.

Reply with the title alone.`,
  reporting: "Reply with the title alone, with no preamble and no explanation.",
  // Nothing to investigate: the conversation is supplied in the prompt.
  tools: [],
};

export const compactionAgent: AgentDefinition = {
  blocking: true,
  description:
    "Summarises a conversation into a durable brief so work can continue with less context.",
  hidden: true,
  mode: "subagent",
  name: "compaction",
  prompt: `You compact a conversation so the work can continue with less context.

Produce a brief that would let another agent resume without reading the original transcript. Preserve, in this order:
1. The user's goal, in their own words.
2. Decisions already made, and the reason for each.
3. What has been implemented, with exact file paths and symbols.
4. What is verified, and the evidence that verified it.
5. What failed, and what was ruled out.
6. What remains, and the next concrete step.
7. Any blocker and the exact missing prerequisite.

Drop pleasantries, restated instructions, superseded plans, and anything already recorded elsewhere. Never invent a decision that was not made, and never claim verification that was not performed. When something is ambiguous in the transcript, say so rather than resolving it.

Write the brief only.`,
  reporting:
    "Write the brief only, using the numbered structure. Omit any section with nothing to record.",
  tools: [],
};
