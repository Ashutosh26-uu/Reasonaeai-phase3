import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  type AuditEvent,
  AuditEventSchema,
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  type UserId,
} from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";
import { deleteFixtures, deleteOrganizations } from "./support/database.js";

const connectionString = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

const describeWithDatabase = connectionString ? describe : describe.skip;
const itWithRedis = redisUrl ? it : it.skip;

/** Every address this file claims lives on a domain it can clean up wholesale. */
const TEST_EMAIL_DOMAIN = "@identity.fixture";

const MAGIC_LINK_TTL_MS = 1000 * 60 * 15;

const DUPLICATE_KEY_PATTERN = /duplicate key/i;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fixtureEmail = (): string => `${randomUUID()}${TEST_EMAIL_DOMAIN}`;

/**
 * A contract-valid event, which is what the store accepts. The organization and
 * project identifiers are only filled in when a test asserts how the store uses
 * them: creation derives the entity's identifier from the event when it names
 * one, so leaving them out is the ordinary case.
 */
function auditEvent(input: {
  action: AuditEvent["action"];
  eventId?: string;
  organizationId?: OrganizationId | null;
  projectId?: ProjectId | null;
  userId: UserId;
}): AuditEvent {
  return AuditEventSchema.parse({
    action: input.action,
    actor: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: "user",
      revokedAt: null,
      sessionId: randomUUID(),
      userId: input.userId,
    },
    eventId: input.eventId ?? randomUUID(),
    metadata: {},
    occurredAt: new Date().toISOString(),
    organizationId: input.organizationId ?? null,
    projectId: input.projectId ?? null,
    requestId: `test-${randomUUID()}`,
    schemaVersion: 1,
  });
}

describeWithDatabase("identity and tenancy store", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationIds: OrganizationId[] = [];
  const auditEventIds: string[] = [];

  beforeAll(async () => {
    await store.migrate();
  });

  afterAll(async () => {
    // Events that name no organization are not reachable from the organization
    // cascade, so the file removes the ones it seeded itself. Rows are removed
    // in dependency order, each with the retry the shared database needs.
    if (auditEventIds.length > 0) {
      await deleteFixtures(
        pool,
        "delete from audit_events where event_id = any($1::uuid[])",
        [auditEventIds]
      );
    }
    await deleteOrganizations(pool, organizationIds);
    await deleteFixtures(
      pool,
      "delete from magic_link_tokens where email like $1",
      [`%${TEST_EMAIL_DOMAIN}`]
    );
    await deleteFixtures(
      pool,
      "delete from users where primary_email like $1",
      [`%${TEST_EMAIL_DOMAIN}`]
    );
    await pool.end();
    await store.close();
  });

  it("claims one account per address however it is typed, creating it once", async () => {
    const email = fixtureEmail();

    const claims = await Promise.all([
      store.users.claimByEmail({ email: email.toUpperCase() }),
      store.users.claimByEmail({ email }),
      store.users.claimByEmail({ email: email.toUpperCase() }),
      store.users.claimByEmail({ email }),
    ]);

    for (const claim of claims) {
      expect(claim.userId).toBe(claims[0]?.userId);
    }
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);

    const rows = await pool.query(
      "select user_id from users where lower(primary_email) = lower($1)",
      [email]
    );
    expect(rows.rowCount).toBe(1);
  });

  it("refuses a magic link that was already consumed, including under a race", async () => {
    const email = fixtureEmail();
    const issued = await store.magicLinks.issue({
      email,
      ttlMs: MAGIC_LINK_TTL_MS,
    });

    const redeemed = await store.magicLinks.consume({ token: issued.token });
    expect(redeemed?.email).toBe(email);
    expect(redeemed?.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
    expect(redeemed?.userId).toBeNull();

    await expect(
      store.magicLinks.consume({ token: issued.token })
    ).resolves.toBeUndefined();

    const raced = await store.magicLinks.issue({
      email,
      ttlMs: MAGIC_LINK_TTL_MS,
    });
    const outcomes = await Promise.all([
      store.magicLinks.consume({ token: raced.token }),
      store.magicLinks.consume({ token: raced.token }),
    ]);

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
  });

  it("refuses an expired magic link without consuming it", async () => {
    const email = fixtureEmail();
    const issued = await store.magicLinks.issue({ email, ttlMs: 1 });

    await wait(50);

    await expect(
      store.magicLinks.consume({ token: issued.token })
    ).resolves.toBeUndefined();

    const stored = await pool.query(
      "select consumed_at from magic_link_tokens where token_hash = $1",
      [sha256(issued.token)]
    );
    expect(stored.rows[0]?.consumed_at).toBeNull();
  });

  it("stores a digest of the token and never the token itself", async () => {
    const email = fixtureEmail();
    const issued = await store.magicLinks.issue({
      email,
      ip: "203.0.113.7",
      ttlMs: MAGIC_LINK_TTL_MS,
    });

    const stored = await pool.query(
      "select * from magic_link_tokens where token_hash = $1",
      [sha256(issued.token)]
    );

    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.token_hash).toBe(sha256(issued.token));
    expect(stored.rows[0]?.token_hash).not.toBe(issued.token);
    expect(JSON.stringify(stored.rows[0])).not.toContain(issued.token);
  });

  it("commits the organization, its owner membership, and its audit row together", async () => {
    const { userId } = await store.users.claimByEmail({
      email: fixtureEmail(),
    });
    const event = auditEvent({ action: "organization.created", userId });

    const created = await store.createOrganizationWithOwner({
      audit: event,
      name: "Atomic Tenancy",
      userId,
    });
    organizationIds.push(created.organizationId);

    expect(created.membershipRole).toBe("owner");
    expect(created.name).toBe("Atomic Tenancy");

    const organization = await pool.query(
      "select name from organizations where organization_id = $1",
      [created.organizationId]
    );
    expect(organization.rows[0]?.name).toBe("Atomic Tenancy");

    const membership = await pool.query(
      `select role, status from organization_memberships
        where organization_id = $1 and user_id = $2`,
      [created.organizationId, userId]
    );
    expect(membership.rows[0]).toMatchObject({
      role: "owner",
      status: "active",
    });

    const trail = await store.audit.listForOrganization({
      limit: 10,
      organizationId: created.organizationId,
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.eventId).toBe(event.eventId);
    expect(trail[0]).toMatchObject({
      action: "organization.created",
      organizationId: created.organizationId,
      schemaVersion: 1,
    });
  });

  it("rolls the organization, membership, and audit row back when any of them fails", async () => {
    const { userId } = await store.users.claimByEmail({
      email: fixtureEmail(),
    });
    const organizationId = OrganizationIdSchema.parse(randomUUID());

    // An event id that is already taken makes the store's own audit insert
    // violate the primary key, after the organization and its membership have
    // been written in the same transaction.
    const claimedEventId = randomUUID();
    await store.audit.record(
      auditEvent({
        action: "capability.issued",
        eventId: claimedEventId,
        userId,
      })
    );
    auditEventIds.push(claimedEventId);

    await expect(
      store.createOrganizationWithOwner({
        audit: auditEvent({
          action: "organization.created",
          eventId: claimedEventId,
          organizationId,
          userId,
        }),
        name: "Rolled Back Tenancy",
        userId,
      })
    ).rejects.toThrow(DUPLICATE_KEY_PATTERN);

    const survivors = await pool.query(
      `select (select count(*) from organizations
                where organization_id = $1) as organizations,
              (select count(*) from organization_memberships
                where organization_id = $1) as memberships,
              (select count(*) from audit_events
                where event_id = $2) as events`,
      [organizationId, claimedEventId]
    );
    expect(survivors.rows[0]).toEqual({
      events: "1",
      memberships: "0",
      organizations: "0",
    });
  });

  it("creates a project with its membership and its audit row", async () => {
    const { userId } = await store.users.claimByEmail({
      email: fixtureEmail(),
    });
    const organization = await store.createOrganizationWithOwner({
      audit: auditEvent({ action: "organization.created", userId }),
      name: "Project Tenancy",
      userId,
    });
    organizationIds.push(organization.organizationId);

    const projectId = ProjectIdSchema.parse(randomUUID());
    const project = await store.createProject({
      audit: auditEvent({
        action: "project.created",
        organizationId: organization.organizationId,
        projectId,
        userId,
      }),
      name: "Launch Project",
      organizationId: organization.organizationId,
      role: "builder",
      userId,
    });

    expect(project).toEqual({
      name: "Launch Project",
      organizationId: organization.organizationId,
      projectId,
      role: "builder",
    });

    const stored = await pool.query(
      `select p.name, m.role, m.status
         from projects p
         join project_memberships m
           on m.organization_id = p.organization_id
          and m.project_id = p.project_id
        where p.project_id = $1 and m.user_id = $2`,
      [projectId, userId]
    );
    expect(stored.rows[0]).toMatchObject({
      name: "Launch Project",
      role: "builder",
      status: "active",
    });

    const trail = await store.audit.listForOrganization({
      limit: 10,
      organizationId: organization.organizationId,
    });
    expect(trail[0]).toMatchObject({ action: "project.created", projectId });

    // An event that names no project leaves the identifier to the store, and
    // the audit row is written with the identifier it committed.
    const generated = await store.createProject({
      audit: auditEvent({
        action: "project.created",
        organizationId: organization.organizationId,
        userId,
      }),
      name: "Second Project",
      organizationId: organization.organizationId,
      role: "viewer",
      userId,
    });

    const secondTrail = await store.audit.listForOrganization({
      limit: 1,
      organizationId: organization.organizationId,
    });
    expect(secondTrail[0]?.projectId).toBe(generated.projectId);
  });

  it("lists only the caller's own active organizations", async () => {
    const owner = await store.users.claimByEmail({ email: fixtureEmail() });
    const outsider = await store.users.claimByEmail({ email: fixtureEmail() });

    const mine = await store.createOrganizationWithOwner({
      audit: auditEvent({
        action: "organization.created",
        userId: owner.userId,
      }),
      name: "Mine",
      userId: owner.userId,
    });
    const theirs = await store.createOrganizationWithOwner({
      audit: auditEvent({
        action: "organization.created",
        userId: outsider.userId,
      }),
      name: "Theirs",
      userId: outsider.userId,
    });
    organizationIds.push(mine.organizationId, theirs.organizationId);

    await store.memberships.grantOrganizationMembership({
      organizationId: mine.organizationId,
      role: "viewer",
      status: "invited",
      userId: outsider.userId,
    });

    await expect(
      store.listOrganizationMemberships({ userId: owner.userId })
    ).resolves.toEqual([
      {
        name: "Mine",
        organizationId: mine.organizationId,
        role: "owner",
      },
    ]);

    // An invitation the outsider has not accepted is not an organization they
    // may be told they belong to.
    await expect(
      store.listOrganizationMemberships({ userId: outsider.userId })
    ).resolves.toEqual([
      {
        name: "Theirs",
        organizationId: theirs.organizationId,
        role: "owner",
      },
    ]);
  });

  it("refuses to store an event the contract does not describe", async () => {
    const { userId } = await store.users.claimByEmail({
      email: fixtureEmail(),
    });
    const event = auditEvent({ action: "organization.created", userId });

    await expect(
      store.audit.record({ ...event, requestId: "" })
    ).rejects.toThrow();

    const stored = await pool.query(
      "select count(*) as events from audit_events where event_id = $1",
      [event.eventId]
    );
    expect(stored.rows[0]?.events).toBe("0");
  });

  it("refuses to read back a row that is not a v1 event", async () => {
    const { userId } = await store.users.claimByEmail({
      email: fixtureEmail(),
    });
    const event = auditEvent({ action: "organization.created", userId });

    const organization = await store.createOrganizationWithOwner({
      audit: event,
      name: "Corrupt Trail",
      userId,
    });
    organizationIds.push(organization.organizationId);

    await pool.query(
      "update audit_events set action = 'not.an.action' where event_id = $1",
      [event.eventId]
    );

    await expect(
      store.audit.listForOrganization({
        limit: 10,
        organizationId: organization.organizationId,
      })
    ).rejects.toThrow();
  });

  itWithRedis(
    "refuses consumeKey once a window is over and keeps consume organization-scoped",
    async () => {
      const key = `identity-key-${randomUUID()}`;
      const window = { burstPerMinute: 1, requestsPerDay: 100 };

      await expect(
        store.rateLimiter.consumeKey({ ...window, key })
      ).resolves.toMatchObject({ allowed: true });

      const refused = await store.rateLimiter.consumeKey({ ...window, key });
      expect(refused.allowed).toBe(false);
      expect(refused.observed).toEqual({ perDay: 2, perMinute: 2 });
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);

      const organizationId = randomUUID();
      await expect(
        store.rateLimiter.consume({ ...window, organizationId })
      ).resolves.toMatchObject({ allowed: true });

      const organizationRefused = await store.rateLimiter.consume({
        ...window,
        organizationId,
      });
      expect(organizationRefused.allowed).toBe(false);
      expect(organizationRefused.observed).toEqual({ perDay: 2, perMinute: 2 });

      // Both entry points share one window, so a spent organization is refused
      // through either of them.
      await expect(
        store.rateLimiter.consumeKey({ ...window, key: organizationId })
      ).resolves.toMatchObject({ allowed: false });
    }
  );
});
