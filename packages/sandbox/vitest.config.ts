import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * These suites start real containers through the Docker daemon. Running
     * files in parallel over-subscribes it, and a container that fails to start
     * fails the suite for a reason the suite is not testing. Files run one at a
     * time; the assertions inside each file are unaffected.
     */
    fileParallelism: false,
  },
});
