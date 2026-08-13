import { afterEach, describe, expect, test, vi } from "vitest";

async function importPlaywrightConfig() {
  vi.resetModules();
  return import("../../../playwright.config");
}

describe("playwright.config isolation", () => {
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

  test("starts this worktree on an explicit isolated port without reusing another listener", async () => {
    vi.stubEnv("E2E_PORT", "3217");
    vi.stubEnv("BETTER_AUTH_URL", "");

    const { default: config } = await importPlaywrightConfig();
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

    expect(config.use?.baseURL).toBe("http://127.0.0.1:3217");
    expect(webServer).toMatchObject({
      command: "npm run dev -- --port 3217",
      reuseExistingServer: false,
      url: "http://127.0.0.1:3217",
    });
    expect(webServer?.env?.BETTER_AUTH_URL).toBe("http://127.0.0.1:3217");
  });

  test("uses the tracked isolated port when the caller does not provide one", async () => {
    vi.stubEnv("E2E_PORT", "");

    const { default: config } = await importPlaywrightConfig();
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

    expect(config.use?.baseURL).toBe("http://127.0.0.1:3101");
    expect(webServer?.url).toBe("http://127.0.0.1:3101");
  });

  test("rejects an invalid E2E_PORT before constructing the dev-server command", async () => {
    vi.stubEnv("E2E_PORT", "3217; stop-process -name node");

    await expect(importPlaywrightConfig()).rejects.toThrowError(/E2E_PORT must be an integer between 1 and 65535/);
  });
});
