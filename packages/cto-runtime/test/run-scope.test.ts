import { RequestContext } from "@mastra/core/request-context";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { describe, expect, it } from "vitest";
import {
  type RunScope,
  readRunScope,
  runScopeKeys,
  sandboxIdFor,
} from "../src/run-scope.js";

const VERIFIED_ERROR_PATTERN = /verified/i;
const SANDBOX_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const scope: RunScope = {
  buildSessionId: BuildSessionIdSchema.parse(
    "00000000-0000-4000-8000-000000000001"
  ),
  organizationId: OrganizationIdSchema.parse(
    "00000000-0000-4000-8000-000000000002"
  ),
  projectId: ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003"),
  runId: RunIdSchema.parse("00000000-0000-4000-8000-000000000004"),
};

function contextWith(values: Partial<Record<keyof RunScope, unknown>>) {
  const requestContext = new RequestContext();
  for (const [name, key] of Object.entries(runScopeKeys)) {
    const value = values[name as keyof RunScope];
    if (value !== undefined) {
      requestContext.setRaw(key, value);
    }
  }
  return requestContext;
}

describe("ReasonateAI run scope", () => {
  it("fails closed when any verified scope component is missing", () => {
    expect(() => readRunScope(new RequestContext())).toThrow(
      VERIFIED_ERROR_PATTERN
    );
    expect(() =>
      readRunScope(contextWith({ ...scope, buildSessionId: undefined }))
    ).toThrow(VERIFIED_ERROR_PATTERN);
  });

  it("rejects malformed identifiers instead of sanitizing them into authority", () => {
    expect(() =>
      readRunScope(contextWith({ ...scope, organizationId: "org-guessed" }))
    ).toThrow(VERIFIED_ERROR_PATTERN);
  });

  it("shares one stable sandbox across agents in the same build session", () => {
    const sandboxId = sandboxIdFor(scope);
    expect(sandboxIdFor(scope)).toBe(sandboxId);
    expect(sandboxId).toMatch(SANDBOX_ID_PATTERN);
  });

  it("isolates sandboxes across tenants, projects, and build sessions", () => {
    const sandboxId = sandboxIdFor(scope);
    expect(
      sandboxIdFor({
        ...scope,
        organizationId: OrganizationIdSchema.parse(
          "00000000-0000-4000-8000-000000000010"
        ),
      })
    ).not.toBe(sandboxId);
    expect(
      sandboxIdFor({
        ...scope,
        projectId: ProjectIdSchema.parse(
          "00000000-0000-4000-8000-000000000011"
        ),
      })
    ).not.toBe(sandboxId);
    expect(
      sandboxIdFor({
        ...scope,
        buildSessionId: BuildSessionIdSchema.parse(
          "00000000-0000-4000-8000-000000000012"
        ),
      })
    ).not.toBe(sandboxId);
  });
});
