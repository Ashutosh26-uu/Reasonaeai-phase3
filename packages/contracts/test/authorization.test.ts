import { describe, expect, it } from "vitest";
import {
  AuthorizationDecisionSchema,
  AuthorizationRequestSchema,
} from "../src/authorization.js";
import { WorkloadPrincipalSchema } from "../src/identity.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const workloadId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";

const validRequest = {
  action: "project:update",
  now: "2026-09-17T12:00:00.000Z",
  organizationMembership: {
    organizationId,
    role: "builder",
    status: "active",
    userId,
  },
  principal: {
    expiresAt: "2026-09-17T13:00:00.000Z",
    kind: "user",
    revokedAt: null,
    sessionId,
    userId,
  },
  projectMembership: {
    organizationId,
    projectId,
    role: "builder",
    status: "active",
    userId,
  },
  resource: {
    kind: "project",
    organizationId,
    projectId,
    resourceId: projectId,
  },
} as const;

describe("authorization contracts", () => {
  it("parses a fully scoped authorization request", () => {
    const parsed = AuthorizationRequestSchema.parse(validRequest);

    expect(parsed.resource.projectId).toBe(projectId);
    expect(parsed.principal.kind).toBe("user");
  });

  it("rejects unknown request fields", () => {
    const result = AuthorizationRequestSchema.safeParse({
      ...validRequest,
      trusted: true,
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed identifiers and timestamps", () => {
    const result = AuthorizationRequestSchema.safeParse({
      ...validRequest,
      now: "tomorrow",
      resource: {
        ...validRequest.resource,
        organizationId: "not-an-organization-id",
      },
    });

    expect(result.success).toBe(false);
  });

  it("prevents workload grants from carrying administrative permissions", () => {
    const result = WorkloadPrincipalSchema.safeParse({
      expiresAt: "2026-09-17T13:00:00.000Z",
      kind: "workload",
      organizationId,
      permissions: ["project:read", "billing:manage"],
      projectId,
      runId,
      workloadId,
    });

    expect(result.success).toBe(false);
  });

  it("keeps authorization decisions typed and closed to unknown data", () => {
    expect(
      AuthorizationDecisionSchema.safeParse({
        allowed: false,
        reason: "PERMISSION_DENIED",
      }).success
    ).toBe(true);
    expect(
      AuthorizationDecisionSchema.safeParse({
        allowed: true,
        source: "capability",
        unsafeOverride: true,
      }).success
    ).toBe(false);
  });
});
