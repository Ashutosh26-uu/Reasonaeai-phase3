import { z } from "zod";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  OrganizationMembershipSchema,
  PermissionSchema,
  PrincipalSchema,
  ProjectIdSchema,
  ProjectMembershipSchema,
} from "./identity.js";

export const authorizationResourceKinds = [
  "organization",
  "project",
  "plan",
  "agent-run",
  "artifact",
  "preview",
  "checkpoint",
  "secret",
  "integration",
  "billing",
] as const;
export const AuthorizationResourceKindSchema = z.enum(
  authorizationResourceKinds
);
export type AuthorizationResourceKind = z.infer<
  typeof AuthorizationResourceKindSchema
>;

export const AuthorizationResourceSchema = z.strictObject({
  kind: AuthorizationResourceKindSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.nullable(),
  resourceId: z.string().min(1).max(256).nullable(),
});
export type AuthorizationResource = z.infer<typeof AuthorizationResourceSchema>;

export const AuthorizationRequestSchema = z.strictObject({
  action: PermissionSchema,
  now: IsoDateTimeSchema,
  organizationMembership: OrganizationMembershipSchema.nullable(),
  principal: PrincipalSchema,
  projectMembership: ProjectMembershipSchema.nullable(),
  resource: AuthorizationResourceSchema,
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

export const authorizationDenialReasons = [
  "UNAUTHENTICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "CAPABILITY_EXPIRED",
  "ORGANIZATION_SCOPE_MISMATCH",
  "PROJECT_SCOPE_MISMATCH",
  "MEMBERSHIP_PRINCIPAL_MISMATCH",
  "ORGANIZATION_MEMBERSHIP_REQUIRED",
  "ORGANIZATION_MEMBERSHIP_INACTIVE",
  "PROJECT_MEMBERSHIP_REQUIRED",
  "PROJECT_MEMBERSHIP_INACTIVE",
  "PERMISSION_DENIED",
] as const;
export const AuthorizationDenialReasonSchema = z.enum(
  authorizationDenialReasons
);
export type AuthorizationDenialReason = z.infer<
  typeof AuthorizationDenialReasonSchema
>;

export const AuthorizationDecisionSchema = z.discriminatedUnion("allowed", [
  z.strictObject({
    allowed: z.literal(true),
    source: z.enum(["organization-role", "project-role", "capability"]),
  }),
  z.strictObject({
    allowed: z.literal(false),
    reason: AuthorizationDenialReasonSchema,
  }),
]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
