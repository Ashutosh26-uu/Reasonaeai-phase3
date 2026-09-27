import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "./workspace.js";

/**
 * The controller the worker drives, narrowed to what driving it needs.
 *
 * A worker needs three things from a session — subscribe to its events, send it
 * the run's directive, and abort the step it is in — and one thing from the
 * controller — create a session bound to the run's scope. Declaring only those
 * keeps the seam a caller can substitute (a scripted controller in a test)
 * without letting a substitute pretend to be the whole controller, and the real
 * `AgentController` satisfies it as written because the members are exact.
 */

export interface RunSession {
  abortRun: () => void;
  sendMessage: (input: {
    content: string;
    requestContext: RequestContext;
    untilIdle?: boolean;
  }) => Promise<void>;
  subscribe: (listener: (event: AgentControllerEvent) => void) => () => void;
}

export interface RunController {
  createSession: (input: {
    requestContext: RequestContext;
    resourceId: string;
    scope: string;
    /**
     * The conversation thread the run must bind. Supplied so a run continues
     * the conversation the project already has rather than opening a thread of
     * its own: the API reads that thread's messages, so a worker that bound a
     * different one would write history nobody sees.
     */
    threadId: string;
  }) => Promise<RunSession>;
  init: () => Promise<void>;
}

export interface RunRuntime {
  readonly controller: RunController;
}

export type RuntimeFactory = () => RunRuntime;

/**
 * The real runtime, composed exactly as the API's chat harness composes it: the
 * sandbox facts the prompt reports, the build workspace as the workspace, the
 * workspace root as the agent's working directory, and — critically — the same
 * durable Mastra store the API reads conversations back from. A worker that
 * drove a session against process-local storage would write a conversation
 * nobody could read again, which is the failure this composition removes.
 *
 * One runtime is built per run. The controller session is process-local,
 * non-authoritative state, so a worker that reuses a runtime between runs would
 * carry a previous run's session, thread binding, and cached resources into the
 * next one; building it per run makes recovery from a takeover or a restart
 * simply "drive a fresh session".
 */
export function createCtoRuntimeFactory(input: {
  model: string;
  storage: MastraCompositeStore;
}): RuntimeFactory {
  return () =>
    createReasonateCtoRuntime({
      ...buildSandboxEnvironment,
      model: input.model,
      storage: input.storage,
      workspace: reasonateBuildWorkspace,
      workspaceRoot: SANDBOX_WORKING_DIRECTORY,
    });
}
