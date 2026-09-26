import { Pool } from "pg";
import { createProjectStateStore } from "../src/postgres.js";

const connectionString =
  "postgresql://postgres:postgres@localhost:5432/reasonateai";
const pool = new Pool({ connectionString });
const store = createProjectStateStore({ connectionString });

const userId = "00000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000002";
const projId = "00000000-0000-4000-8000-000000000003";

async function runSeed() {
  console.log("--> Seeding PostgreSQL database schema and records...");

  // 1. Run Migrations
  await store.migrate();

  // 2. Seed User
  await pool.query(
    "INSERT INTO users (user_id, primary_email) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
    [userId, "dev@reasonate.ai"]
  );

  // 3. Seed Organization
  await pool.query(
    "INSERT INTO organizations (organization_id, name) VALUES ($1, $2) ON CONFLICT (organization_id) DO NOTHING",
    [orgId, "ReasonateAI Dev Org"]
  );

  // 4. Seed Project
  await pool.query(
    "INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3) ON CONFLICT (organization_id, project_id) DO NOTHING",
    [projId, orgId, "ReasonateAI Demo Project"]
  );

  // 5. Grant Organization Membership (Role: owner)
  await store.memberships.grantOrganizationMembership({
    organizationId: orgId,
    role: "owner",
    status: "active",
    userId,
  });

  // 6. Grant Project Membership (Role: builder)
  await store.memberships.grantProjectMembership({
    organizationId: orgId,
    projectId: projId,
    role: "builder",
    status: "active",
    userId,
  });

  // 7. Create Session
  const { token } = await store.sessions.createSession({
    absoluteTtlMs: 30 * 86_400_000,
    idleTtlMs: 30 * 86_400_000,
    userId,
  });

  console.log("\n=======================================================");
  console.log("SUCCESS: Database Seeded Successfully!");
  console.log("-------------------------------------------------------");
  console.log("User ID         :", userId);
  console.log("Organization ID :", orgId);
  console.log("Project ID      :", projId);
  console.log("Membership Role : owner (Org) / builder (Project)");
  console.log("-------------------------------------------------------");
  console.log("BROWSER COOKIE HEADER TO SET:");
  console.log(`reasonate_session=${token}`);
  console.log("=======================================================\n");

  await pool.end();
}

runSeed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
