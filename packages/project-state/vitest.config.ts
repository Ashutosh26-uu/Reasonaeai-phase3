import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * These suites talk to one shared PostgreSQL and Redis instance. Running
     * files in parallel races the shared database and outbox claims.
     * Files run one at a time; assertions inside each file are unaffected.
     */
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
