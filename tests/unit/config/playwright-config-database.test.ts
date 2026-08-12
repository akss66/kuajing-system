import { afterEach, describe, expect, test, vi } from "vitest";

async function importPlaywrightConfig() {
  vi.resetModules();
  return import("../../../playwright.config");
}

describe("playwright.config database isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("forces DATABASE_URL to the resolved TEST_DATABASE_URL before exporting the config", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://prod-user:prod-pass@db.example.com:5432/tongzhouxing");
    vi.stubEnv("TEST_DATABASE_URL", "postgres://test-user:test-pass@127.0.0.1:5432/tongzhouxing_test");

    const { default: config } = await importPlaywrightConfig();
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

    expect(process.env.DATABASE_URL).toBe("postgres://test-user:test-pass@127.0.0.1:5432/tongzhouxing_test");
    expect(webServer?.env?.DATABASE_URL).toBe("postgres://test-user:test-pass@127.0.0.1:5432/tongzhouxing_test");
  });
});
