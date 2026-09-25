import { z } from "zod";
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
  organizations: z.array(OrganizationSummarySchema),
  sessionId: SessionIdSchema,
  userId: UserIdSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const CreateOrganizationRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export type CreateOrganizationRequest = z.infer<
  typeof CreateOrganizationRequestSchema
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

export const SignedOutSchema = z.strictObject({
  revoked: z.boolean(),
});
export type SignedOut = z.infer<typeof SignedOutSchema>;
