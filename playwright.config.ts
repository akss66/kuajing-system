import { defineConfig, devices } from "@playwright/test";
import { configureE2ETestDatabaseEnvironment } from "./tests/e2e/support/test-database";

function resolveE2EPort(rawPort: string | undefined) {
  const normalized = rawPort?.trim();
  if (!normalized) return 3000;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("E2E_PORT must be an integer between 1024 and 65534");
  }
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_534) {
    throw new Error("E2E_PORT must be an integer between 1024 and 65534");
  }
  return port;
}

const e2eDatabaseUrl = configureE2ETestDatabaseEnvironment(process.env);
const e2ePort = resolveE2EPort(process.env.E2E_PORT);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eJifengEnvironment = Object.fromEntries(
  [
    "JIFENG_BASE_URL",
    "JIFENG_CLIENT_ID",
    "JIFENG_CLIENT_SECRET",
    "JIFENG_TOKEN_ENCRYPTION_KEY",
  ].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
);
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
    command: `npm run dev -- --port ${e2ePort}`,
    env: {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: e2eBaseUrl,
      DATABASE_URL: e2eDatabaseUrl,
      ...e2eJifengEnvironment,
      PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
      TEST_DATABASE_URL: e2eDatabaseUrl,
    },
    url: e2eBaseUrl,
    reuseExistingServer: !process.env.CI,
  },
});
