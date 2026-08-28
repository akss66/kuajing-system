import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

import {
  configureE2ETestDatabaseEnvironment,
  resolveE2EPort,
} from "./tests/e2e/support/test-database";

function deriveE2EPort(basePort: number, offset: number) {
  const minimumPort = 1_024;
  const portCount = 65_534 - minimumPort + 1;
  return minimumPort + ((basePort - minimumPort + offset) % portCount);
}

const jifengEnvironmentNames = [
  "JIFENG_ACCESS_TOKEN",
  "JIFENG_BASE_URL",
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
  "JIFENG_LEGACY_FULFILLMENT_ENABLED",
  "JIFENG_LEGACY_WRITE_ENABLED",
  "JIFENG_LOGISTICS_ID",
  "JIFENG_REFRESH_TOKEN",
  "JIFENG_TOKEN_ENCRYPTION_KEY",
  "JIFENG_USER_ID",
  "JIFENG_WAREHOUSE_CODE",
] as const;
const jifengConnectionSpecPattern = /jifeng-connection\.spec\.ts$/;

const e2eDatabaseUrl = configureE2ETestDatabaseEnvironment(process.env);
const e2ePortValue = resolveE2EPort(process.env.E2E_PORT);
const e2ePort = Number(e2ePortValue);
if (e2ePort < 1_024 || e2ePort > 65_534) {
  throw new Error("E2E_PORT must be an integer between 1024 and 65534");
}
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eJifengAppPort = deriveE2EPort(e2ePort, 10_000);
const e2eJifengMockPort = deriveE2EPort(e2ePort, 20_000);
const e2eJifengBaseUrl = `http://127.0.0.1:${e2eJifengAppPort}`;
const e2eJifengMockUrl = `http://127.0.0.1:${e2eJifengMockPort}`;
const explicitSpecArguments = process.argv.filter((argument) =>
  /\.spec\.[cm]?[jt]sx?(?::\d+)?$/i.test(argument),
);

function isJifengConnectionSpec(argument: string) {
  const normalized = argument.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)jifeng-connection\.spec\.ts(?::\d+)?$/.test(normalized);
}

const runsJifengConnectionSpec =
  explicitSpecArguments.length === 0 ||
  explicitSpecArguments.some(isJifengConnectionSpec);
const runsNormalSpecs =
  explicitSpecArguments.length === 0 ||
  explicitSpecArguments.some((argument) => !isJifengConnectionSpec(argument));

for (const name of jifengEnvironmentNames) delete process.env[name];
if (runsJifengConnectionSpec) {
  process.env.E2E_JIFENG_MOCK_URL = e2eJifengMockUrl;
} else {
  delete process.env.E2E_JIFENG_MOCK_URL;
}

process.env.BETTER_AUTH_SECRET ??= "e2e-only-secret-with-at-least-32-characters";
process.env.BETTER_AUTH_URL = e2eBaseUrl;
process.env.CATALOG_ASSET_DIR = resolve(
  process.cwd(),
  process.env.CATALOG_ASSET_DIR?.trim() || ".e2e-catalog-assets",
);
process.env.PII_ENCRYPTION_KEY ??=
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const commonWebServerEnvironment = {
  AI_SKU_MATCH_ENABLED: "true",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  CATALOG_ASSET_DIR: process.env.CATALOG_ASSET_DIR,
  DATABASE_URL: e2eDatabaseUrl,
  DEEPSEEK_API_KEY: "e2e-placeholder-never-sent",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  FEISHU_API_BASE_URL:
    process.env.FEISHU_API_BASE_URL ?? "http://127.0.0.1:4010",
  FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? "e2e-feishu-app-id",
  FEISHU_APP_SECRET:
    process.env.FEISHU_APP_SECRET ?? "e2e-feishu-app-secret",
  FEISHU_CARGO_IMPORT_ENABLED: "true",
  FEISHU_CATALOG_MIRROR_CUTOFF_AT: "2099-01-01T00:00:00+08:00",
  FEISHU_CATALOG_MIRROR_ENABLED: "true",
  FEISHU_CARGO_SOURCE_WIKI_TOKEN:
    process.env.FEISHU_CARGO_SOURCE_WIKI_TOKEN ?? "wiki-source-token",
  FEISHU_CARGO_TARGET_SHEET_ID:
    process.env.FEISHU_CARGO_TARGET_SHEET_ID ?? "target-sheet-id",
  FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN:
    process.env.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN ??
    "target-spreadsheet-token",
  FEISHU_CARGO_WRITES_ENABLED: "false",
  PII_ENCRYPTION_KEY: process.env.PII_ENCRYPTION_KEY,
  TEST_DATABASE_URL: e2eDatabaseUrl,
};

const normalProjects = [
  {
    grepInvert: /@mobile-only/,
    name: "desktop-chromium",
    testIgnore: jifengConnectionSpecPattern,
    use: {
      ...devices["Desktop Chrome"],
      baseURL: e2eBaseUrl,
      viewport: { width: 1440, height: 900 },
    },
  },
  {
    grepInvert: /@desktop-only/,
    name: "mobile-chromium",
    testIgnore: jifengConnectionSpecPattern,
    use: {
      ...devices["Pixel 5"],
      baseURL: e2eBaseUrl,
      viewport: { width: 390, height: 844 },
    },
  },
];
const jifengProjects = [
  {
    grepInvert: /@mobile-only/,
    name: "jifeng-desktop-chromium",
    testMatch: jifengConnectionSpecPattern,
    use: {
      ...devices["Desktop Chrome"],
      baseURL: e2eJifengBaseUrl,
      viewport: { width: 1440, height: 900 },
    },
  },
  {
    grepInvert: /@desktop-only/,
    name: "jifeng-mobile-chromium",
    testMatch: jifengConnectionSpecPattern,
    use: {
      ...devices["Pixel 5"],
      baseURL: e2eJifengBaseUrl,
      viewport: { width: 390, height: 844 },
    },
  },
];
const isolatedServerMode =
  runsNormalSpecs && runsJifengConnectionSpec
    ? "both"
    : runsJifengConnectionSpec
      ? "jifeng"
      : "normal";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  workers: 1,
  use: { trace: "on-first-retry" },
  projects: [
    ...(runsNormalSpecs ? normalProjects : []),
    ...(runsJifengConnectionSpec ? jifengProjects : []),
  ],
  webServer: {
    command:
      "node tests/e2e/support/start-isolated-app-servers.mjs" +
      ` --mode ${isolatedServerMode}` +
      ` --normal-port ${e2ePort}` +
      ` --jifeng-port ${e2eJifengAppPort}` +
      ` --jifeng-mock-url ${e2eJifengMockUrl}`,
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 10_000,
    },
    env: {
      ...commonWebServerEnvironment,
      BETTER_AUTH_URL: e2eBaseUrl,
      E2E_PORT: e2ePortValue,
    },
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 180_000,
    url: runsNormalSpecs ? e2eBaseUrl : e2eJifengBaseUrl,
  },
});
