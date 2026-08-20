import { defineConfig } from "vitest/config";

import { configureIntegrationTestDatabaseEnvironment } from "./tests/integration/database-environment.js";

configureIntegrationTestDatabaseEnvironment(process.env);
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-with-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3000";
process.env.PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/integration/global-setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    setupFiles: ["./tests/integration/setup.ts"],
  },
});
