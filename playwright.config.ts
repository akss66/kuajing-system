import { defineConfig, devices } from "@playwright/test";
import {
  configureE2ETestDatabaseEnvironment,
  isDerivedLocalE2ETestDatabaseUrl,
  resolveE2EPort,
} from "./tests/e2e/support/test-database";

const callerProvidedTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());
const e2ePortValue = resolveE2EPort(process.env.E2E_PORT);
const e2ePort = Number(e2ePortValue);

const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eDatabaseUrl = configureE2ETestDatabaseEnvironment(process.env);
process.env.BETTER_AUTH_SECRET ??= "e2e-only-secret-with-at-least-32-characters";
process.env.BETTER_AUTH_URL = e2eBaseUrl;
process.env.PII_ENCRYPTION_KEY ??=
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  workers: 1,
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      grepInvert: /@mobile-only/,
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      grepInvert: /@desktop-only/,
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command:
      !callerProvidedTestDatabase &&
      isDerivedLocalE2ETestDatabaseUrl(e2eDatabaseUrl, e2ePortValue)
        ? `npm run test:e2e:server -- --port ${e2ePort}`
        : `npm run dev -- --port ${e2ePort}`,
    env: {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      DATABASE_URL: e2eDatabaseUrl,
      E2E_PORT: e2ePortValue,
      PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
      TEST_DATABASE_URL: e2eDatabaseUrl,
    },
    url: e2eBaseUrl,
    reuseExistingServer: false,
  },
});
