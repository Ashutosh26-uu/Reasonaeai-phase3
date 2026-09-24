import { randomUUID } from "node:crypto";
import { UserIdSchema } from "@reasonateai/contracts/identity";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";

const connectionString = process.env.DATABASE_URL;
const HOUR = 1000 * 60 * 60;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("browser session store", () => {
  const pool = new Pool({ connectionString });
  const store = createProjectStateStore({
    connectionString: connectionString as string,
    sessionIdleTtlMs: 2 * HOUR,
  });

  const userId = UserIdSchema.parse(randomUUID());
  const otherUserId = UserIdSchema.parse(randomUUID());

  beforeAll(async () => {
    await store.migrate();
    await pool.query(
      `insert into users (user_id, primary_email)
       select fixture_id, NULL from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[userId, otherUserId]]
    );
  });

  afterAll(async () => {
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [userId, otherUserId],
    ]);
    await pool.end();
    await store.close();
  });

  it("stores only a digest of the session token, never the token itself", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    const stored = await pool.query<{ token_hash: string }>(
      "select token_hash from auth_sessions where session_id = $1",
      [issued.session.sessionId]
    );

    expect(stored.rows[0]?.token_hash).toBeDefined();
    expect(stored.rows[0]?.token_hash).not.toBe(issued.token);
    expect(stored.rows[0]?.token_hash).toMatch(SHA256_HEX_PATTERN);
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
  });

  it("resolves a live session and refuses an unknown token", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    const resolved = await store.sessions.resolveSession(issued.token);
    expect(resolved?.sessionId).toBe(issued.session.sessionId);
    expect(resolved?.userId).toBe(userId);

    expect(await store.sessions.resolveSession("not-a-real-token")).toBe(
      undefined
    );
  });

  it("stops resolving a session immediately after revocation", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    expect(await store.sessions.revokeSession(issued.session.sessionId)).toBe(
      true
    );
    expect(await store.sessions.resolveSession(issued.token)).toBe(undefined);
    expect(await store.sessions.revokeSession(issued.session.sessionId)).toBe(
      false
    );
  });

  it("invalidates the previous token on rotation and links the lineage", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    const rotated = await store.sessions.rotateSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      token: issued.token,
    });

    expect(rotated?.session.sessionId).not.toBe(issued.session.sessionId);
    expect(rotated?.session.rotatedFromSessionId).toBe(
      issued.session.sessionId
    );
    expect(await store.sessions.resolveSession(issued.token)).toBe(undefined);
    expect(
      (await store.sessions.resolveSession(rotated?.token as string))?.sessionId
    ).toBe(rotated?.session.sessionId);
  });

  it("revokes every live session for one user without touching another user", async () => {
    const first = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    const second = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    const untouched = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId: otherUserId,
    });

    expect(await store.sessions.revokeAllUserSessions(userId)).toBeGreaterThan(
      0
    );
    expect(await store.sessions.resolveSession(first.token)).toBe(undefined);
    expect(await store.sessions.resolveSession(second.token)).toBe(undefined);
    expect((await store.sessions.resolveSession(untouched.token))?.userId).toBe(
      otherUserId
    );
  });

  it("refuses a session past its absolute expiry even while idle-fresh", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    await pool.query(
      `update auth_sessions
          set absolute_expires_at = now() - interval '1 second',
              idle_expires_at = now() + interval '1 hour'
        where session_id = $1`,
      [issued.session.sessionId]
    );

    expect(await store.sessions.resolveSession(issued.token)).toBe(undefined);
  });

  it("caps idle extension at the absolute expiry", async () => {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 3 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });

    const touched = await store.sessions.resolveSession(issued.token);
    expect(touched).toBeDefined();
    expect(
      new Date(touched?.idleExpiresAt as string).getTime()
    ).toBeLessThanOrEqual(
      new Date(touched?.absoluteExpiresAt as string).getTime()
    );
  });
});
