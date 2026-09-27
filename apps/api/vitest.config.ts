import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Several of these suites start real containers and talk to one shared
     * PostgreSQL and Redis. Running files in parallel over-subscribes the Docker
     * daemon and races the shared services, which fails a suite for a reason it
     * is not testing. Files run one at a time; assertions are unaffected.
     */
    fileParallelism: false,
  },
});
