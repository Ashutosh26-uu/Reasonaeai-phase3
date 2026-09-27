import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { RequestContext } from "@mastra/core/request-context";
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
  }) => Promise<RunSession>;
  init: () => Promise<void>;
}

export interface RunRuntime {
  readonly controller: RunController;
}

export type RuntimeFactory = () => RunRuntime;

/**
 * The real runtime, composed exactly as the API's chat harness composes it: the
 * sandbox facts the prompt reports, the build workspace as the workspace, and
 * the workspace root as the agent's working directory.
 *
 * One runtime is built per run. The controller session is process-local,
 * non-authoritative state, so a worker that reuses a runtime between runs would
 * carry a previous run's session, thread binding, and cached resources into the
 * next one; building it per run makes recovery from a takeover or a restart
 * simply "drive a fresh session".
 */
export function createCtoRuntimeFactory(input: {
  model: string;
}): RuntimeFactory {
  return () =>
    createReasonateCtoRuntime({
      ...buildSandboxEnvironment,
      model: input.model,
      workspace: reasonateBuildWorkspace,
      workspaceRoot: SANDBOX_WORKING_DIRECTORY,
    });
}
