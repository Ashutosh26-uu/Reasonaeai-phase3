import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectStateStore } from "../src/postgres.js";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
describeWithDatabase("durable provider identities", () => {
  const store = createProjectStateStore({
    connectionString: connectionString ?? "",
  });
  const pool = new Pool({ connectionString });
  const domain = `${randomUUID()}.identity.test`;
  const state = randomBytes(32).toString("base64url");
  const states = [state];
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  beforeAll(async () => {
    await store.migrate();
  });
  afterAll(async () => {
    await pool.query("delete from users where primary_email like $1", [
      `%@${domain}`,
    ]);
    await pool.query(
      "delete from identity_oidc_requests where state_hash = any($1::text[])",
      [states.map(digest)]
    );
    await pool.end();
    await store.close();
  });
  it("consumes a flow once, across simultaneous callbacks and expiry", async () => {
    await store.identity.beginOidc(state);
    expect(
      (
        await Promise.all([
          store.identity.consumeOidc(state),
          store.identity.consumeOidc(state),
        ])
      ).filter(Boolean)
    ).toHaveLength(1);
    const expired = randomBytes(32).toString("base64url");
    states.push(expired);
    await store.identity.beginOidc(expired);
    await pool.query(
      "update identity_oidc_requests set expires_at = now() - interval '1 second' where state_hash = $1",
      [digest(expired)]
    );
    expect(await store.identity.consumeOidc(expired)).toBe(false);
  });
  it("claims one account concurrently and preserves the stable provider subject", async () => {
    const email = `google@${domain}`;
    const subject = randomUUID();
    const results = await Promise.all([
      store.identity.claimGoogle({ email, subject }),
      store.identity.claimGoogle({ email, subject }),
    ]);
    expect(results[0]?.userId).toBe(results[1]?.userId);
    expect(results.filter((claim) => claim.created)).toHaveLength(1);
    const result = await store.identity.claimGoogle({
      email: `changed@${domain}`,
      subject,
    });
    expect(result.userId).toBe(results[0]?.userId);
    expect(await store.users.onboardingComplete(result.userId)).toBe(false);
    await store.migrate();
    expect(await store.users.onboardingComplete(result.userId)).toBe(false);
  });
  it("links an authoritative verified email to its existing account", async () => {
    const email = `existing@${domain}`;
    const original = await store.users.claimByEmail({ email });
    const linked = await store.identity.claimGoogle({
      email,
      subject: randomUUID(),
    });
    expect(linked).toEqual({ created: false, userId: original.userId });
  });
});
