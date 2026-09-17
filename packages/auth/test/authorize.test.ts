import { AuthorizationRequestSchema } from "@reasonateai/contracts/authorization";
import { describe, expect, it } from "vitest";
import { authorize } from "../src/authorize.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const otherProjectId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const workloadId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";

const baseRequest = {
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

const decide = (input: unknown) =>
  authorize(AuthorizationRequestSchema.parse(input));

describe("authorize", () => {
  it("allows a project builder to update an assigned project", () => {
    expect(decide(baseRequest)).toEqual({
      allowed: true,
      source: "project-role",
    });
  });

  it("denies a builder an administrative project permission", () => {
    expect(decide({ ...baseRequest, action: "project:delete" })).toEqual({
      allowed: false,
      reason: "PERMISSION_DENIED",
    });
  });

  it("lets an organization owner administer a project without project membership", () => {
    expect(
      decide({
        ...baseRequest,
        action: "project:delete",
        organizationMembership: {
          ...baseRequest.organizationMembership,
          role: "owner",
        },
        projectMembership: null,
      })
    ).toEqual({ allowed: true, source: "organization-role" });
  });

  it("requires project membership for non-administrative organization roles", () => {
    expect(decide({ ...baseRequest, projectMembership: null })).toEqual({
      allowed: false,
      reason: "PROJECT_MEMBERSHIP_REQUIRED",
    });
  });

  it("rejects a membership from another organization", () => {
    expect(
      decide({
        ...baseRequest,
        organizationMembership: {
          ...baseRequest.organizationMembership,
          organizationId: otherOrganizationId,
        },
      })
    ).toEqual({
      allowed: false,
      reason: "ORGANIZATION_SCOPE_MISMATCH",
    });
  });

  it("rejects a membership from another project", () => {
    expect(
      decide({
        ...baseRequest,
        projectMembership: {
          ...baseRequest.projectMembership,
          projectId: otherProjectId,
        },
      })
    ).toEqual({
      allowed: false,
      reason: "PROJECT_SCOPE_MISMATCH",
    });
  });

  it("rejects suspended memberships", () => {
    expect(
      decide({
        ...baseRequest,
        organizationMembership: {
          ...baseRequest.organizationMembership,
          status: "suspended",
        },
      })
    ).toEqual({
      allowed: false,
      reason: "ORGANIZATION_MEMBERSHIP_INACTIVE",
    });
  });

  it("rejects revoked and expired user sessions", () => {
    expect(
      decide({
        ...baseRequest,
        principal: {
          ...baseRequest.principal,
          revokedAt: "2026-09-17T11:00:00.000Z",
        },
      })
    ).toEqual({ allowed: false, reason: "SESSION_REVOKED" });

    expect(
      decide({
        ...baseRequest,
        principal: {
          ...baseRequest.principal,
          expiresAt: "2026-09-17T12:00:00.000Z",
        },
      })
    ).toEqual({ allowed: false, reason: "SESSION_EXPIRED" });
  });

  it("allows only explicitly granted workload permissions in the exact scope", () => {
    const workloadRequest = {
      ...baseRequest,
      organizationMembership: null,
      principal: {
        expiresAt: "2026-09-17T13:00:00.000Z",
        kind: "workload",
        organizationId,
        permissions: ["project:update"],
        projectId,
        runId,
        workloadId,
      },
      projectMembership: null,
    } as const;

    expect(decide(workloadRequest)).toEqual({
      allowed: true,
      source: "capability",
    });
    expect(decide({ ...workloadRequest, action: "artifact:read" })).toEqual({
      allowed: false,
      reason: "PERMISSION_DENIED",
    });
  });

  it("rejects expired and cross-project workload capabilities", () => {
    const workloadRequest = {
      ...baseRequest,
      organizationMembership: null,
      principal: {
        expiresAt: "2026-09-17T12:00:00.000Z",
        kind: "workload",
        organizationId,
        permissions: ["project:update"],
        projectId,
        runId,
        workloadId,
      },
      projectMembership: null,
    } as const;

    expect(decide(workloadRequest)).toEqual({
      allowed: false,
      reason: "CAPABILITY_EXPIRED",
    });
    expect(
      decide({
        ...workloadRequest,
        principal: {
          ...workloadRequest.principal,
          expiresAt: "2026-09-17T13:00:00.000Z",
        },
        resource: {
          ...workloadRequest.resource,
          projectId: otherProjectId,
        },
      })
    ).toEqual({ allowed: false, reason: "PROJECT_SCOPE_MISMATCH" });
  });

  it("denies anonymous callers before membership evaluation", () => {
    expect(
      decide({
        ...baseRequest,
        organizationMembership: null,
        principal: { kind: "anonymous" },
        projectMembership: null,
      })
    ).toEqual({ allowed: false, reason: "UNAUTHENTICATED" });
  });
});
