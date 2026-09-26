import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Each suite works inside its own temporary root and links, so no shared
     * service or directory is contested and files stay parallel. Declared
     * explicitly so the isolation requirement is visible next to the other
     * packages' configs.
     */
    fileParallelism: true,
  },
});
