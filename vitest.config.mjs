import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // avif/webp encoding can be slow on a cold start.
    testTimeout: 15000,
  },
});
