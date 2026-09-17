import type {
  AuthorizationDecision,
  AuthorizationDenialReason,
  AuthorizationRequest,
} from "@reasonateai/contracts/authorization";
import type {
  OrganizationRole,
  Permission,
  ProjectRole,
  UserPrincipal,
  WorkloadPrincipal,
} from "@reasonateai/contracts/identity";

type PermissionTable = Readonly<Partial<Record<Permission, true>>>;

const viewerPermissions = {
  "artifact:read": true,
  "organization:read": true,
  "preview:open": true,
  "project:read": true,
} as const satisfies PermissionTable;

const reviewerPermissions = {
  ...viewerPermissions,
  "plan:review": true,
} as const satisfies PermissionTable;

const builderPermissions = {
  ...reviewerPermissions,
  "agent:abort": true,
  "agent:run": true,
  "checkpoint:restore": true,
  "plan:approve": true,
  "project:create": true,
  "project:update": true,
  "secret:submit": true,
} as const satisfies PermissionTable;

const adminPermissions = {
  ...builderPermissions,
  "integration:manage": true,
  "member:invite": true,
  "member:manage": true,
  "organization:update": true,
  "project:delete": true,
} as const satisfies PermissionTable;

const ownerPermissions = {
  ...adminPermissions,
  "billing:manage": true,
  "organization:delete": true,
  "organization:transfer": true,
} as const satisfies PermissionTable;

const organizationRolePermissions: Readonly<
  Record<OrganizationRole, PermissionTable>
> = {
  admin: adminPermissions,
  builder: builderPermissions,
  owner: ownerPermissions,
  reviewer: reviewerPermissions,
  viewer: viewerPermissions,
};

const projectRolePermissions: Readonly<Record<ProjectRole, PermissionTable>> = {
  builder: builderPermissions,
  reviewer: reviewerPermissions,
  viewer: viewerPermissions,
};

const deny = (reason: AuthorizationDenialReason): AuthorizationDecision => ({
  allowed: false,
  reason,
});

const authorizeWorkload = (
  request: AuthorizationRequest,
  principal: WorkloadPrincipal
): AuthorizationDecision => {
  const { action, now, resource } = request;
  if (Date.parse(principal.expiresAt) <= Date.parse(now)) {
    return deny("CAPABILITY_EXPIRED");
  }
  if (principal.organizationId !== resource.organizationId) {
    return deny("ORGANIZATION_SCOPE_MISMATCH");
  }
  if (
    resource.projectId === null ||
    principal.projectId !== resource.projectId
  ) {
    return deny("PROJECT_SCOPE_MISMATCH");
  }
  if (!principal.permissions.some((permission) => permission === action)) {
    return deny("PERMISSION_DENIED");
  }
  return { allowed: true, source: "capability" };
};

const authorizeUser = (
  request: AuthorizationRequest,
  principal: UserPrincipal
): AuthorizationDecision => {
  const { action, now, organizationMembership, projectMembership, resource } =
    request;
  if (principal.revokedAt !== null) {
    return deny("SESSION_REVOKED");
  }
  if (Date.parse(principal.expiresAt) <= Date.parse(now)) {
    return deny("SESSION_EXPIRED");
  }
  if (organizationMembership === null) {
    return deny("ORGANIZATION_MEMBERSHIP_REQUIRED");
  }
  if (organizationMembership.userId !== principal.userId) {
    return deny("MEMBERSHIP_PRINCIPAL_MISMATCH");
  }
  if (organizationMembership.organizationId !== resource.organizationId) {
    return deny("ORGANIZATION_SCOPE_MISMATCH");
  }
  if (organizationMembership.status !== "active") {
    return deny("ORGANIZATION_MEMBERSHIP_INACTIVE");
  }

  if (
    resource.projectId === null ||
    organizationMembership.role === "owner" ||
    organizationMembership.role === "admin"
  ) {
    return organizationRolePermissions[organizationMembership.role][action] ===
      true
      ? { allowed: true, source: "organization-role" }
      : deny("PERMISSION_DENIED");
  }

  if (projectMembership === null) {
    return deny("PROJECT_MEMBERSHIP_REQUIRED");
  }
  if (projectMembership.userId !== principal.userId) {
    return deny("MEMBERSHIP_PRINCIPAL_MISMATCH");
  }
  if (projectMembership.organizationId !== resource.organizationId) {
    return deny("ORGANIZATION_SCOPE_MISMATCH");
  }
  if (projectMembership.projectId !== resource.projectId) {
    return deny("PROJECT_SCOPE_MISMATCH");
  }
  if (projectMembership.status !== "active") {
    return deny("PROJECT_MEMBERSHIP_INACTIVE");
  }

  return projectRolePermissions[projectMembership.role][action] === true
    ? { allowed: true, source: "project-role" }
    : deny("PERMISSION_DENIED");
};

export const authorize = (
  request: AuthorizationRequest
): AuthorizationDecision => {
  const { principal } = request;
  if (principal.kind === "anonymous") {
    return deny("UNAUTHENTICATED");
  }
  return principal.kind === "workload"
    ? authorizeWorkload(request, principal)
    : authorizeUser(request, principal);
};
