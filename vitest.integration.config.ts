import { defineConfig } from "vitest/config";

process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ??
  "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test";
export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
