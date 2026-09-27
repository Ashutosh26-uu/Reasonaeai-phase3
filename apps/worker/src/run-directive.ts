import type { BuildSessionId } from "@reasonateai/contracts/execution";
import type { RunId } from "@reasonateai/contracts/identity";

/**
 * What the worker says to the CTO when it starts a run.
 *
 * A run row carries identity and sandbox facts, not a prompt: dispatch is the
 * act of handing the project's workspace to its own CTO for the next unit of
 * work, and the CTO's instructions, the project's memory, and the restored
 * checkpoint carry what that work is. So the directive names the run, states
 * that the workspace is restored, and states what a finished turn must report —
 * it does not invent an objective the durable record never held.
 */
export function runDirective(input: {
  buildSessionId: BuildSessionId;
  runId: RunId;
}): string {
  return [
    `Run ${input.runId} of build session ${input.buildSessionId} is dispatched to the execution plane.`,
    "The project workspace has been restored to the project's latest accepted checkpoint and this run owns it until it ends.",
    "Continue the project's work now: inspect the workspace, complete the next unit of work, and verify it yourself before you report.",
    "End your turn with what changed, how you verified it, what remains, and anything you need.",
  ].join(" ");
}
