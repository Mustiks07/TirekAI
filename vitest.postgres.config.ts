import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/postgres.integration.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
