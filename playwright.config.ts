import { defineConfig, devices } from "@playwright/test";

process.env.DATABASE_URL ??=
  "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test";
process.env.BETTER_AUTH_SECRET ??= "e2e-only-secret-with-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3000";
process.env.PII_ENCRYPTION_KEY ??=
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run dev",
    env: {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
    },
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
  },
});
