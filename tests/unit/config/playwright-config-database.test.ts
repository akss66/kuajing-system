import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const originalArgv = [...process.argv];
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
const isolatedServerLauncherPath = fileURLToPath(
  new URL("../../e2e/support/start-isolated-app-servers.mjs", import.meta.url),
);

async function importPlaywrightConfig() {
  vi.resetModules();
  return import("../../../playwright.config");
}

function listWebServers(config: Awaited<ReturnType<typeof importPlaywrightConfig>>["default"]) {
  if (!config.webServer) return [];
  return Array.isArray(config.webServer) ? config.webServer : [config.webServer];
}

function matches(pattern: string | RegExp | Array<string | RegExp> | undefined, path: string) {
  const patterns = Array.isArray(pattern) ? pattern : pattern ? [pattern] : [];
  return patterns.some((candidate) =>
    typeof candidate === "string" ? path.includes(candidate) : candidate.test(path),
  );
}

describe("playwright.config database isolation", () => {
  beforeEach(() => {
    process.argv = [...originalArgv];
    vi.stubEnv("CATALOG_ASSET_DIR", undefined);
    vi.stubEnv("E2E_JIFENG_MOCK_URL", undefined);
    vi.stubEnv("E2E_PORT", undefined);
    for (const name of jifengEnvironmentNames) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    process.argv = [...originalArgv];
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

  test("explicitly enables Feishu writes only inside the fake E2E server", async () => {
    vi.stubEnv("E2E_PORT", "3101");
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("FEISHU_CARGO_WRITES_ENABLED", "");

    const { default: config } = await importPlaywrightConfig();
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;

    expect(webServer?.env?.FEISHU_CARGO_WRITES_ENABLED).toBe("true");
  });

  test("shares one absolute catalog asset root between the runner and isolated app workspaces", async () => {
    vi.stubEnv("CATALOG_ASSET_DIR", ".e2e-test-catalog-assets");

    const { default: config } = await importPlaywrightConfig();
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    const expectedAssetRoot = resolve(process.cwd(), ".e2e-test-catalog-assets");

    expect(isAbsolute(process.env.CATALOG_ASSET_DIR ?? "")).toBe(true);
    expect(process.env.CATALOG_ASSET_DIR).toBe(expectedAssetRoot);
    expect(webServer?.env?.CATALOG_ASSET_DIR).toBe(expectedAssetRoot);
  });

  test("runs an explicitly unrelated spec only in normal projects and without Jifeng environment", async () => {
    process.argv = ["node", "playwright", "test", "tests/e2e/login.spec.ts"];

    const { default: config } = await importPlaywrightConfig();
    const webServers = listWebServers(config);

    expect(config.projects?.map(({ name }) => name)).toEqual([
      "desktop-chromium",
      "mobile-chromium",
    ]);
    expect(webServers).toHaveLength(1);
    expect(config.projects?.every(({ use }) => use?.baseURL === "http://127.0.0.1:3101")).toBe(true);
    for (const name of jifengEnvironmentNames) {
      expect(process.env[name]).toBeUndefined();
      expect(webServers[0]?.env?.[name]).toBeUndefined();
    }
  });

  test("runs the explicit connection spec only in Jifeng projects against isolated loopback ports", async () => {
    process.argv = [
      "node",
      "playwright",
      "test",
      "tests/e2e/jifeng-connection.spec.ts",
    ];

    const { default: config } = await importPlaywrightConfig();
    const webServers = listWebServers(config);

    expect(config.projects?.map(({ name }) => name)).toEqual([
      "jifeng-desktop-chromium",
      "jifeng-mobile-chromium",
    ]);
    expect(config.projects?.every(({ use }) => use?.baseURL === "http://127.0.0.1:13101")).toBe(true);
    expect(webServers).toHaveLength(1);
    expect(webServers[0]).toMatchObject({
      url: "http://127.0.0.1:13101",
    });
    expect(webServers[0]?.command).toContain("start-isolated-app-servers.mjs --mode jifeng");
    expect(process.env.E2E_JIFENG_MOCK_URL).toBe("http://127.0.0.1:23101");
    for (const name of jifengEnvironmentNames) {
      expect(process.env[name]).toBeUndefined();
    }
  });

  test("separates full-suite normal and Jifeng projects, base URLs, matching, and app servers", async () => {
    process.argv = ["node", "playwright", "test", "--workers", "1"];

    const { default: config } = await importPlaywrightConfig();
    const webServers = listWebServers(config);
    const projects = config.projects ?? [];
    const normalProjects = projects.filter(({ name }) => !name?.startsWith("jifeng-"));
    const jifengProjects = projects.filter(({ name }) => name?.startsWith("jifeng-"));

    expect(projects.map(({ name }) => name)).toEqual([
      "desktop-chromium",
      "mobile-chromium",
      "jifeng-desktop-chromium",
      "jifeng-mobile-chromium",
    ]);
    expect(normalProjects.every(({ use }) => use?.baseURL === "http://127.0.0.1:3101")).toBe(true);
    expect(jifengProjects.every(({ use }) => use?.baseURL === "http://127.0.0.1:13101")).toBe(true);
    expect(normalProjects.every(({ testIgnore }) => matches(testIgnore, "jifeng-connection.spec.ts"))).toBe(true);
    expect(jifengProjects.every(({ testMatch }) => matches(testMatch, "jifeng-connection.spec.ts"))).toBe(true);
    expect(webServers.map(({ url }) => url)).toEqual(["http://127.0.0.1:3101"]);
    expect(webServers[0]?.command).toContain("start-isolated-app-servers.mjs --mode both");
    expect(webServers[0]?.env?.JIFENG_BASE_URL).toBeUndefined();
  });

  test("purges hostile Jifeng shell values from the runner and normal app while giving only the isolated app safe values", async () => {
    process.argv = ["node", "playwright", "test", "--workers", "1"];
    for (const name of jifengEnvironmentNames) {
      vi.stubEnv(name, `hostile-${name.toLowerCase()}`);
    }

    const { default: config } = await importPlaywrightConfig();
    const webServers = listWebServers(config);
    const launcherWebServer = webServers[0];
    for (const name of jifengEnvironmentNames) {
      expect(process.env[name]).toBeUndefined();
      expect(launcherWebServer?.env?.[name]).toBeUndefined();
    }
  });

  test("derives three distinct valid ports when E2E_PORT is near the upper boundary", async () => {
    process.argv = ["node", "playwright", "test"];
    vi.stubEnv("E2E_PORT", "60000");

    const { default: config } = await importPlaywrightConfig();

    expect(listWebServers(config).map(({ url }) => url)).toEqual(["http://127.0.0.1:60000"]);
    expect(listWebServers(config)[0]?.command).toContain(
      "--normal-port 60000 --jifeng-port 5489 --jifeng-mock-url http://127.0.0.1:15489",
    );
    expect(process.env.E2E_JIFENG_MOCK_URL).toBe("http://127.0.0.1:15489");
  });

  test("launcher starts isolated Jifeng then normal dev workspaces with safe process arguments and environment", () => {
    const result = spawnSync(
      process.execPath,
      [
        isolatedServerLauncherPath,
        "--dry-run",
        "--mode",
        "both",
        "--normal-port",
        "3000",
        "--jifeng-port",
        "13000",
        "--jifeng-mock-url",
        "http://127.0.0.1:23000",
      ],
      {
        encoding: "utf8",
        env: Object.fromEntries([
          ...Object.entries(process.env),
          ...jifengEnvironmentNames.map((name) => [name, `hostile-${name.toLowerCase()}`]),
        ]),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      cleanup: {
        markerName: string;
        root: string;
        signals: string[];
        staleDirectoryPrefix: string;
        terminateOrder: string[];
      };
      layout: {
        copiedDirectories: string[];
        copiedFiles: string[];
        excludedInputs: string[];
        linkedDirectories: string[];
      };
      processes: Array<{
        args: string[];
        jifengEnvironment: Record<string, string>;
        name: string;
        url: string;
        workspace: string;
        workspaceCwd: string;
        workspaceDistDir: string;
      }>;
    };
    expect(plan.layout).toEqual({
      copiedDirectories: ["public", "src"],
      copiedFiles: [
        "AGENTS.md",
        "components.json",
        "next-env.d.ts",
        "next.config.ts",
        "package.json",
        "postcss.config.mjs",
        "tsconfig.json",
      ],
      excludedInputs: [
        ".env*",
        ".git",
        "playwright-report",
        "test-results",
        "user data",
      ],
      linkedDirectories: ["node_modules"],
    });
    expect(plan.cleanup).toMatchObject({
      markerName: ".jifeng-e2e-run.json",
      signals: ["SIGINT", "SIGTERM"],
      staleDirectoryPrefix: "jifeng-e2e-",
      terminateOrder: ["normal", "jifeng"],
    });
    expect(plan.cleanup.root.replaceAll("\\", "/")).toMatch(
      /\/\.next\/e2e-apps\/jifeng-e2e-dry-run$/,
    );
    expect(plan.processes).toMatchObject([
      {
        args: ["run", "dev", "--", "--port", "13000"],
        jifengEnvironment: {
          JIFENG_BASE_URL: "http://127.0.0.1:23000",
          JIFENG_CLIENT_ID: "e2e-only-client-id",
          JIFENG_CLIENT_SECRET: "e2e-client-secret-private",
          JIFENG_TOKEN_ENCRYPTION_KEY:
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        },
        name: "jifeng",
        url: "http://127.0.0.1:13000",
        workspace: "jifeng",
      },
      {
        args: ["run", "dev", "--", "--port", "3000"],
        jifengEnvironment: {},
        name: "normal",
        url: "http://127.0.0.1:3000",
        workspace: "normal",
      },
    ]);
    expect(new Set(plan.processes.map(({ workspaceCwd }) => workspaceCwd)).size).toBe(2);
    expect(new Set(plan.processes.map(({ workspaceDistDir }) => workspaceDistDir)).size).toBe(2);
    for (const processPlan of plan.processes) {
      expect(processPlan.workspaceCwd.replaceAll("\\", "/")).toContain(
        `/.next/e2e-apps/jifeng-e2e-dry-run/${processPlan.workspace}`,
      );
      expect(processPlan.workspaceDistDir.replaceAll("\\", "/")).toBe(
        `${processPlan.workspaceCwd.replaceAll("\\", "/")}/.next`,
      );
    }
  });
});
