import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isMockModeEnabled,
  resetStateStoreForTest,
  resolvePrincipal,
  stateStore,
} from "../src/mastra/index.js";

describe("state store and principal resolution configuration", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalStateMode = process.env.PROJECT_STATE_MODE;

  beforeEach(() => {
    resetStateStoreForTest();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalStateMode === undefined) {
      delete process.env.PROJECT_STATE_MODE;
    } else {
      process.env.PROJECT_STATE_MODE = originalStateMode;
    }

    resetStateStoreForTest();
  });

  it("requires DATABASE_URL in production mode and fails initialization if missing", () => {
    delete process.env.DATABASE_URL;
    delete process.env.PROJECT_STATE_MODE;

    expect(isMockModeEnabled()).toBe(false);
    expect(() => stateStore()).toThrowError(
      "DATABASE_URL is required: the authoritative project store is not configured."
    );
  });

  it("does not return default development principal in production mode for unauthenticated requests", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.PROJECT_STATE_MODE;

    // Set a dummy connection string to allow stateStore initialization without a real DB pool query
    process.env.DATABASE_URL =
      "postgres://postgres:postgres@127.0.0.1:5432/postgres";

    const principal = await resolvePrincipal({ cookieHeader: undefined });
    expect(principal).toBeUndefined();
  });

  it("allows mock store when PROJECT_STATE_MODE=mock is explicitly set", () => {
    delete process.env.DATABASE_URL;
    process.env.PROJECT_STATE_MODE = "mock";

    expect(isMockModeEnabled()).toBe(true);
    const store = stateStore();
    expect(store).toBeDefined();
    expect(typeof store.allocateBuildSession).toBe("function");
  });

  it("allows default development principal when PROJECT_STATE_MODE=mock is explicitly set", async () => {
    delete process.env.DATABASE_URL;
    process.env.PROJECT_STATE_MODE = "mock";

    const principal = await resolvePrincipal({ cookieHeader: undefined });
    expect(principal).toBeDefined();
    expect(principal?.kind).toBe("user");
    expect(principal?.sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });
});
