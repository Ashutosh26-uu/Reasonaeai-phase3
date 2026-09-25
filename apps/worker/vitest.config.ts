import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * These suites start real containers through the Docker daemon and talk to
     * one shared PostgreSQL. Running files in parallel over-subscribes the
     * daemon and races the shared database, which fails a suite for a reason it
     * is not testing. Files run one at a time; assertions are unaffected.
     */
    fileParallelism: false,
    /**
     * A case here starts a container, restores a Git bundle into it, snapshots
     * the workspace back out, and waits for a lease to lapse, so the default
     * five seconds measures the machine rather than the code.
     */
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
