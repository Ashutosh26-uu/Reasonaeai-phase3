import type { RequestContext } from "@mastra/core/request-context";
import {
  type BuildSessionId,
  BuildSessionIdSchema,
} from "@reasonateai/contracts/execution";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type RunId,
  RunIdSchema,
} from "@reasonateai/contracts/identity";

export const runScopeKeys = {
  buildSessionId: "reasonateai.buildSessionId",
  organizationId: "reasonateai.organizationId",
  projectId: "reasonateai.projectId",
  runId: "reasonateai.runId",
} as const;

export interface RunScope {
  buildSessionId: BuildSessionId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  runId: RunId;
}

function readIdentifier<T>(
  requestContext: RequestContext,
  key: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }
): T {
  const parsed = schema.safeParse(requestContext.getRaw(key));
  if (!parsed.success || parsed.data === undefined) {
    throw new Error(
      "A verified organization, project, build session, and run scope is required."
    );
  }
  return parsed.data;
}

export function readRunScope(requestContext: RequestContext): RunScope {
  return {
    buildSessionId: readIdentifier(
      requestContext,
      runScopeKeys.buildSessionId,
      BuildSessionIdSchema
    ),
    organizationId: readIdentifier(
      requestContext,
      runScopeKeys.organizationId,
      OrganizationIdSchema
    ),
    projectId: readIdentifier(
      requestContext,
      runScopeKeys.projectId,
      ProjectIdSchema
    ),
    runId: readIdentifier(requestContext, runScopeKeys.runId, RunIdSchema),
  };
}

export function sandboxIdFor(scope: RunScope): string {
  return [
    "reasonate",
    scope.organizationId,
    scope.projectId,
    scope.buildSessionId,
  ]
    .join("-")
    .replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}
