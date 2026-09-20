import {
  type MembershipStatus,
  MembershipStatusSchema,
  type OrganizationMembership,
  OrganizationMembershipSchema,
  type OrganizationRole,
  OrganizationRoleSchema,
  type ProjectMembership,
  ProjectMembershipSchema,
  type ProjectRole,
  ProjectRoleSchema,
} from "@reasonateai/contracts/identity";
import type { Pool } from "pg";

export interface MembershipRepository {
  /**
   * Returns the caller's membership in an organization, or `undefined` when the
   * caller is not a member. A missing row is a denial input, never a reason to
   * continue with elevated trust.
   */
  getOrganizationMembership: (input: {
    organizationId: string;
    userId: string;
  }) => Promise<OrganizationMembership | undefined>;
  getProjectMembership: (input: {
    organizationId: string;
    projectId: string;
    userId: string;
  }) => Promise<ProjectMembership | undefined>;
  grantOrganizationMembership: (input: {
    organizationId: string;
    role: OrganizationRole;
    status: MembershipStatus;
    userId: string;
  }) => Promise<OrganizationMembership>;
  grantProjectMembership: (input: {
    organizationId: string;
    projectId: string;
    role: ProjectRole;
    status: MembershipStatus;
    userId: string;
  }) => Promise<ProjectMembership>;
}

export function createMembershipRepository(pool: Pool): MembershipRepository {
  return {
    getOrganizationMembership: async ({ organizationId, userId }) => {
      const result = await pool.query(
        `select organization_id, user_id, role, status
           from organization_memberships
          where organization_id = $1 and user_id = $2`,
        [organizationId, userId]
      );

      const [row] = result.rows;
      return row
        ? OrganizationMembershipSchema.parse({
            organizationId: row.organization_id,
            role: OrganizationRoleSchema.parse(row.role),
            status: MembershipStatusSchema.parse(row.status),
            userId: row.user_id,
          })
        : undefined;
    },

    getProjectMembership: async ({ organizationId, projectId, userId }) => {
      const result = await pool.query(
        `select organization_id, project_id, user_id, role, status
           from project_memberships
          where organization_id = $1 and project_id = $2 and user_id = $3`,
        [organizationId, projectId, userId]
      );

      const [row] = result.rows;
      return row
        ? ProjectMembershipSchema.parse({
            organizationId: row.organization_id,
            projectId: row.project_id,
            role: ProjectRoleSchema.parse(row.role),
            status: MembershipStatusSchema.parse(row.status),
            userId: row.user_id,
          })
        : undefined;
    },

    grantOrganizationMembership: async (input) => {
      const result = await pool.query(
        `insert into organization_memberships
           (organization_id, user_id, role, status)
         values ($1, $2, $3, $4)
         on conflict (organization_id, user_id)
         do update set role = excluded.role, status = excluded.status
         returning organization_id, user_id, role, status`,
        [input.organizationId, input.userId, input.role, input.status]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Organization membership upsert returned no row.");
      }

      return OrganizationMembershipSchema.parse({
        organizationId: row.organization_id,
        role: OrganizationRoleSchema.parse(row.role),
        status: MembershipStatusSchema.parse(row.status),
        userId: row.user_id,
      });
    },

    grantProjectMembership: async (input) => {
      const result = await pool.query(
        `insert into project_memberships
           (organization_id, project_id, user_id, role, status)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id, project_id, user_id)
         do update set role = excluded.role, status = excluded.status
         returning organization_id, project_id, user_id, role, status`,
        [
          input.organizationId,
          input.projectId,
          input.userId,
          input.role,
          input.status,
        ]
      );

      const [row] = result.rows;
      if (!row) {
        throw new Error("Project membership upsert returned no row.");
      }

      return ProjectMembershipSchema.parse({
        organizationId: row.organization_id,
        projectId: row.project_id,
        role: ProjectRoleSchema.parse(row.role),
        status: MembershipStatusSchema.parse(row.status),
        userId: row.user_id,
      });
    },
  };
}
