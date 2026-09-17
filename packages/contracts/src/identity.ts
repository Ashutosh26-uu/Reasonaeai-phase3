import { z } from "zod";

export const UserIdSchema = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;

export const OrganizationIdSchema = z.uuid().brand<"OrganizationId">();
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;

export const ProjectIdSchema = z.uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const SessionIdSchema = z.uuid().brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const WorkloadIdSchema = z.uuid().brand<"WorkloadId">();
export type WorkloadId = z.infer<typeof WorkloadIdSchema>;

export const RunIdSchema = z.uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const AuditEventIdSchema = z.uuid().brand<"AuditEventId">();
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;

export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const organizationRoles = [
  "owner",
  "admin",
  "builder",
  "reviewer",
  "viewer",
] as const;
export const OrganizationRoleSchema = z.enum(organizationRoles);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const projectRoles = ["builder", "reviewer", "viewer"] as const;
export const ProjectRoleSchema = z.enum(projectRoles);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const MembershipStatusSchema = z.enum([
  "invited",
  "active",
  "suspended",
]);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const OrganizationMembershipSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  role: OrganizationRoleSchema,
  status: MembershipStatusSchema,
  userId: UserIdSchema,
});
export type OrganizationMembership = z.infer<
  typeof OrganizationMembershipSchema
>;

export const ProjectMembershipSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  role: ProjectRoleSchema,
  status: MembershipStatusSchema,
  userId: UserIdSchema,
});
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

export const AnonymousPrincipalSchema = z.strictObject({
  kind: z.literal("anonymous"),
});
export type AnonymousPrincipal = z.infer<typeof AnonymousPrincipalSchema>;

export const UserPrincipalSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  kind: z.literal("user"),
  revokedAt: IsoDateTimeSchema.nullable(),
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
});
export type UserPrincipal = z.infer<typeof UserPrincipalSchema>;

export const permissions = [
  "organization:read",
  "organization:update",
  "organization:delete",
  "organization:transfer",
  "member:invite",
  "member:manage",
  "project:create",
  "project:read",
  "project:update",
  "project:delete",
  "plan:review",
  "plan:approve",
  "agent:run",
  "agent:abort",
  "artifact:read",
  "preview:open",
  "checkpoint:restore",
  "secret:submit",
  "integration:manage",
  "billing:manage",
] as const;
export const PermissionSchema = z.enum(permissions);
export type Permission = z.infer<typeof PermissionSchema>;

export const workloadPermissions = [
  "project:read",
  "project:update",
  "plan:review",
  "artifact:read",
  "preview:open",
] as const satisfies readonly Permission[];
export const WorkloadPermissionSchema = z.enum(workloadPermissions);
export type WorkloadPermission = z.infer<typeof WorkloadPermissionSchema>;

export const WorkloadPrincipalSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
  kind: z.literal("workload"),
  organizationId: OrganizationIdSchema,
  permissions: z.array(WorkloadPermissionSchema).readonly(),
  projectId: ProjectIdSchema,
  runId: RunIdSchema,
  workloadId: WorkloadIdSchema,
});
export type WorkloadPrincipal = z.infer<typeof WorkloadPrincipalSchema>;

export const PrincipalSchema = z.discriminatedUnion("kind", [
  AnonymousPrincipalSchema,
  UserPrincipalSchema,
  WorkloadPrincipalSchema,
]);
export type Principal = z.infer<typeof PrincipalSchema>;

export const SessionSchema = z.strictObject({
  absoluteExpiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  idleExpiresAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  rotatedFromSessionId: SessionIdSchema.nullable(),
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const AuditActionSchema = z.enum([
  "identity.signed_in",
  "identity.signed_out",
  "identity.session_revoked",
  "organization.created",
  "organization.membership_changed",
  "project.created",
  "authorization.denied",
  "capability.issued",
  "capability.revoked",
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

const AuditMetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const AuditEventSchema = z.strictObject({
  action: AuditActionSchema,
  actor: PrincipalSchema,
  eventId: AuditEventIdSchema,
  metadata: z.record(z.string(), AuditMetadataValueSchema),
  occurredAt: IsoDateTimeSchema,
  organizationId: OrganizationIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  requestId: z.string().min(1).max(128),
  schemaVersion: z.literal(1),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
