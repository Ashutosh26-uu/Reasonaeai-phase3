import { z } from "zod";
import {
  EntitlementsSchema,
  PlanIdSchema,
  UsageSnapshotSchema,
} from "./entitlements.js";
import {
  IsoDateTimeSchema,
  OrganizationIdSchema,
  OrganizationRoleSchema,
  ProjectIdSchema,
  ProjectRoleSchema,
  SessionIdSchema,
  UserIdSchema,
} from "./identity.js";

/**
 * Browser cookie and header names for the session and its CSRF companion. They
 * live here so the routes, the middleware, and their tests agree on one set of
 * names instead of each restating them.
 */
export const SESSION_COOKIE = "reasonate_session";
export const CSRF_COOKIE = "reasonate_csrf";
export const CSRF_HEADER = "x-reasonate-csrf";

/**
 * A sign-in request carries only the address to reach. The accepted response
 * never says whether that address has an account, so it cannot be used to
 * enumerate users, and it never carries the token itself.
 */
export const MagicLinkRequestSchema = z.strictObject({
  email: z.email().max(254),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkAcceptedSchema = z.strictObject({
  delivery: z.enum(["email", "local"]).default("email"),
  expiresAt: IsoDateTimeSchema,
});
export type MagicLinkAccepted = z.infer<typeof MagicLinkAcceptedSchema>;

export const OrganizationSummarySchema = z.strictObject({
  name: z.string().min(1),
  organizationId: OrganizationIdSchema,
  role: OrganizationRoleSchema,
});
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

/**
 * What a browser may know about its own session: when it ends, which
 * organizations the caller belongs to, and nothing about the token that
 * authenticates it. The token exists only inside the cookie.
 */
export const SessionViewSchema = z.strictObject({
  absoluteExpiresAt: IsoDateTimeSchema,
  idleExpiresAt: IsoDateTimeSchema,
  onboardingComplete: z.boolean().default(true),
  organizations: z.array(OrganizationSummarySchema),
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const AccountProfileSchema = z.strictObject({
  displayName: z.string().max(80).nullable(),
  email: z.email().max(254).nullable(),
  userId: UserIdSchema,
});
export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const UpdateAccountProfileRequestSchema = z.strictObject({
  displayName: z.string().max(80),
});
export type UpdateAccountProfileRequest = z.infer<
  typeof UpdateAccountProfileRequestSchema
>;

export const OrganizationPlanUsageSchema = z.strictObject({
  billingMode: z.literal("default"),
  entitlements: EntitlementsSchema,
  plan: PlanIdSchema,
  usage: UsageSnapshotSchema,
});
export type OrganizationPlanUsage = z.infer<typeof OrganizationPlanUsageSchema>;

export const CreateOrganizationRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export type CreateOrganizationRequest = z.infer<
  typeof CreateOrganizationRequestSchema
>;

export const RenameOrganizationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});
export type RenameOrganizationRequest = z.infer<
  typeof RenameOrganizationRequestSchema
>;

export const CreateOrganizationResponseSchema = z.strictObject({
  membershipRole: OrganizationRoleSchema,
  name: z.string().min(1),
  organizationId: OrganizationIdSchema,
});
export type CreateOrganizationResponse = z.infer<
  typeof CreateOrganizationResponseSchema
>;

export const CreateProjectRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  organizationId: OrganizationIdSchema,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectViewSchema = z.strictObject({
  name: z.string().min(1),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  role: ProjectRoleSchema,
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const ProjectSummarySchema = z.strictObject({
  name: z.string().min(1),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export const ProjectListSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema),
});

export const SignedOutSchema = z.strictObject({
  revoked: z.boolean(),
});
export type SignedOut = z.infer<typeof SignedOutSchema>;

export const AuthOptionsSchema = z.strictObject({
  email: z.enum(["email", "local", "unavailable"]),
  google: z.boolean(),
});
export type AuthOptions = z.infer<typeof AuthOptionsSchema>;

export const RedeemMagicLinkSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const CompleteOnboardingSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  organizationId: OrganizationIdSchema,
  workspaceName: z.string().trim().min(1).max(120),
});
export const DeviceSessionSchema = z.strictObject({
  absoluteExpiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  current: z.boolean(),
  idleExpiresAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  sessionId: SessionIdSchema,
});
export const DeviceSessionsSchema = z.strictObject({
  sessions: z.array(DeviceSessionSchema).max(100),
});
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;
