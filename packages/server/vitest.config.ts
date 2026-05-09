import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/globalEnv.ts"],
    testTimeout: 30_000,
    // First run of mongodb-memory-server downloads the MongoDB binary (~80MB).
    // Give the download room; subsequent runs are instant.
    hookTimeout: 300_000,
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
