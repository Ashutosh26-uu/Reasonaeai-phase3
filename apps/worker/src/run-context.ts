import { RequestContext } from "@mastra/core/request-context";
import {
  type RunScope,
  runScopeKeys,
} from "@reasonateai/cto-runtime/run-scope";
import type { RunnableRun } from "@reasonateai/project-state/postgres";
import type { LogFields } from "./logger.js";

/**
 * The run scope, as a `RequestContext` and as log fields.
 *
 * Every run-scoped decision in the runtime — which sandbox to resolve, which
 * resource router answers a read, which memory resource a session binds — reads
 * the four scope keys off the request context, and the run row holds all four.
 * The worker therefore never invents a scope: it copies one.
 */

/** The scope of a runnable run, as the runtime's scope contract expresses it. */
export function candidateScope(candidate: RunnableRun): RunScope {
  return {
    buildSessionId: candidate.buildSessionId,
    organizationId: candidate.organizationId,
    projectId: candidate.projectId,
    runId: candidate.runId,
  };
}

export function createRunRequestContext(scope: RunScope): RequestContext {
  const requestContext = new RequestContext();
  requestContext.setRaw(runScopeKeys.buildSessionId, scope.buildSessionId);
  requestContext.setRaw(runScopeKeys.organizationId, scope.organizationId);
  requestContext.setRaw(runScopeKeys.projectId, scope.projectId);
  requestContext.setRaw(runScopeKeys.runId, scope.runId);
  return requestContext;
}

/**
 * The identity every line about a run carries. Nothing else about a run is
 * assumed to be safe to log.
 */
export function runLogFields(scope: RunScope): LogFields {
  return {
    buildSessionId: scope.buildSessionId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    runId: scope.runId,
  };
}
