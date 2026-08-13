import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const JIFENG_ENVIRONMENT_NAMES = [
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
];
const SAFE_JIFENG_ENVIRONMENT = {
  JIFENG_CLIENT_ID: "e2e-only-client-id",
  JIFENG_CLIENT_SECRET: "e2e-client-secret-private",
  JIFENG_TOKEN_ENCRYPTION_KEY:
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
};
const LINKED_DIRECTORIES = ["node_modules"];
const COPIED_DIRECTORIES = ["public", "src"];
const COPIED_FILES = [
  "AGENTS.md",
  "components.json",
  "next-env.d.ts",
  "next.config.ts",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
];
const EXCLUDED_WORKSPACE_INPUTS = [
  ".env*",
  ".git",
  "playwright-report",
  "test-results",
  "user data",
];
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM"];
const RUN_DIRECTORY_PREFIX = "jifeng-e2e-";
const RUN_MARKER_NAME = ".jifeng-e2e-run.json";
const RUN_MARKER_OWNER = "start-isolated-app-servers";

function readOption(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || !arguments_[index + 1]) {
    throw new Error(`${name} is required`);
  }
  return arguments_[index + 1];
}

function parsePort(raw, name) {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_534) {
    throw new Error(`${name} must be between 1024 and 65534`);
  }
  return port;
}

function withoutJifengEnvironment(source) {
  const environment = { ...source };
  for (const name of JIFENG_ENVIRONMENT_NAMES) delete environment[name];
  delete environment.E2E_JIFENG_MOCK_URL;
  return environment;
}

function jifengEnvironmentOnly(environment) {
  return Object.fromEntries(
    JIFENG_ENVIRONMENT_NAMES.flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

function assertPathWithinProject(projectRoot, target, label) {
  const resolvedProjectRoot = resolve(projectRoot);
  const resolvedTarget = resolve(target);
  const targetRelativePath = relative(resolvedProjectRoot, resolvedTarget);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error(`${label} must resolve to a child of the project root`);
  }
  return resolvedTarget;
}

function assertRunRoot(projectRoot, runRoot) {
  const e2eAppsRoot = assertPathWithinProject(
    projectRoot,
    join(projectRoot, ".next", "e2e-apps"),
    "E2E apps root",
  );
  const resolvedRunRoot = assertPathWithinProject(projectRoot, runRoot, "E2E run root");
  if (dirname(resolvedRunRoot) !== e2eAppsRoot || !/^[a-zA-Z0-9-]+$/.test(basename(resolvedRunRoot))) {
    throw new Error("E2E run root must be one exact run-id directory under .next/e2e-apps");
  }
  return resolvedRunRoot;
}

function isSafeRunDirectoryName(name, allowLegacy = false) {
  const prefixedPattern = /^jifeng-e2e-(?:dry-run|\d+-[0-9a-f-]{36})$/;
  const legacyPattern = /^\d+-[0-9a-f-]{36}$/;
  return prefixedPattern.test(name) || (allowLegacy && legacyPattern.test(name));
}

function readOwnedRunMarker(projectRoot, runRoot, allowLegacy = false) {
  const resolvedRunRoot = assertRunRoot(projectRoot, runRoot);
  const runName = basename(resolvedRunRoot);
  if (!isSafeRunDirectoryName(runName, allowLegacy)) {
    throw new Error(`E2E run directory name is not owned by this launcher: ${runName}`);
  }
  const metadata = lstatSync(resolvedRunRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`E2E run root must be a real directory: ${resolvedRunRoot}`);
  }
  const markerPath = join(resolvedRunRoot, RUN_MARKER_NAME);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (
    marker.owner !== RUN_MARKER_OWNER ||
    marker.version !== 1 ||
    marker.pid === undefined ||
    marker.projectRoot !== resolve(projectRoot) ||
    marker.runRoot !== resolvedRunRoot
  ) {
    throw new Error(`E2E run marker did not match the owned directory: ${resolvedRunRoot}`);
  }
  return marker;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeOwnedRunRoot(projectRoot, runRoot, options = {}) {
  const marker = readOwnedRunMarker(projectRoot, runRoot, options.allowLegacy);
  if (!options.allowCurrentProcess && isProcessAlive(marker.pid)) return false;
  rmSync(assertRunRoot(projectRoot, runRoot), { force: true, recursive: true });
  return true;
}

function cleanupStaleRunRoots(projectRoot) {
  const appsRoot = join(projectRoot, ".next", "e2e-apps");
  if (!existsSync(appsRoot)) return;
  for (const entry of readdirSync(appsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_DIRECTORY_PREFIX)) continue;
    try {
      removeOwnedRunRoot(projectRoot, join(appsRoot, entry.name));
    } catch {
      // Foreign, malformed, or live directories are never deleted automatically.
    }
  }
}

function createPlan(arguments_, sourceEnvironment, projectRoot) {
  const mode = readOption(arguments_, "--mode");
  if (!new Set(["both", "jifeng", "normal"]).has(mode)) {
    throw new Error("--mode must be one of: both, jifeng, normal");
  }
  const normalPort = parsePort(readOption(arguments_, "--normal-port"), "--normal-port");
  const jifengPort = parsePort(readOption(arguments_, "--jifeng-port"), "--jifeng-port");
  const mockUrl = new URL(readOption(arguments_, "--jifeng-mock-url"));
  if (
    mockUrl.protocol !== "http:" ||
    mockUrl.hostname !== "127.0.0.1" ||
    !mockUrl.port ||
    mockUrl.username ||
    mockUrl.password ||
    mockUrl.pathname !== "/" ||
    mockUrl.search ||
    mockUrl.hash
  ) {
    throw new Error("--jifeng-mock-url must be an origin on http://127.0.0.1");
  }
  const mockPort = parsePort(mockUrl.port, "--jifeng-mock-url port");
  if (new Set([normalPort, jifengPort, mockPort]).size !== 3) {
    throw new Error("normal, Jifeng app, and Jifeng mock ports must be distinct");
  }

  const baseEnvironment = withoutJifengEnvironment(sourceEnvironment);
  const runId = arguments_.includes("--dry-run")
    ? `${RUN_DIRECTORY_PREFIX}dry-run`
    : `${RUN_DIRECTORY_PREFIX}${process.pid}-${randomUUID()}`;
  const runRoot = assertRunRoot(
    projectRoot,
    join(projectRoot, ".next", "e2e-apps", runId),
  );
  const jifengWorkspace = join(runRoot, "jifeng");
  const normalWorkspace = join(runRoot, "normal");
  const jifengEnvironment = {
    ...baseEnvironment,
    ...SAFE_JIFENG_ENVIRONMENT,
    BETTER_AUTH_URL: `http://127.0.0.1:${jifengPort}`,
    JIFENG_BASE_URL: mockUrl.origin,
  };
  const normalEnvironment = {
    ...baseEnvironment,
    BETTER_AUTH_URL: `http://127.0.0.1:${normalPort}`,
  };
  const processes = [];
  if (mode === "both" || mode === "jifeng") {
    processes.push({
      args: ["run", "dev", "--", "--port", String(jifengPort)],
      cwd: jifengWorkspace,
      environment: jifengEnvironment,
      name: "jifeng",
      readinessUrl: `http://127.0.0.1:${jifengPort}/login`,
      url: `http://127.0.0.1:${jifengPort}`,
    });
  }
  if (mode === "both" || mode === "normal") {
    processes.push({
      args: ["run", "dev", "--", "--port", String(normalPort)],
      cwd: normalWorkspace,
      environment: normalEnvironment,
      name: "normal",
      readinessUrl: `http://127.0.0.1:${normalPort}/login`,
      url: `http://127.0.0.1:${normalPort}`,
    });
  }
  return {
    mode,
    processes,
    projectRoot,
    runRoot,
  };
}

function publicPlan(plan) {
  return {
    cleanup: {
      markerName: RUN_MARKER_NAME,
      root: plan.runRoot,
      signals: CLEANUP_SIGNALS,
      staleDirectoryPrefix: RUN_DIRECTORY_PREFIX,
      terminateOrder: [...plan.processes].reverse().map(({ name }) => name),
    },
    layout: {
      copiedDirectories: COPIED_DIRECTORIES,
      copiedFiles: COPIED_FILES,
      excludedInputs: EXCLUDED_WORKSPACE_INPUTS,
      linkedDirectories: LINKED_DIRECTORIES,
    },
    mode: plan.mode,
    processes: plan.processes.map((processPlan) => ({
      args: processPlan.args,
      jifengEnvironment: jifengEnvironmentOnly(processPlan.environment),
      name: processPlan.name,
      readinessUrl: processPlan.readinessUrl,
      url: processPlan.url,
      workspace: processPlan.name,
      workspaceCwd: processPlan.cwd,
      workspaceDistDir: join(processPlan.cwd, ".next"),
    })),
  };
}

function materializeWorkspace(plan, workspace) {
  mkdirSync(workspace, { recursive: true });
  for (const name of LINKED_DIRECTORIES) {
    const target = assertPathWithinProject(
      plan.projectRoot,
      join(plan.projectRoot, name),
      `${name} link target`,
    );
    if (!existsSync(target)) throw new Error(`Required workspace directory is missing: ${target}`);
    symlinkSync(target, join(workspace, name), process.platform === "win32" ? "junction" : "dir");
  }
  for (const name of COPIED_DIRECTORIES) {
    const source = assertPathWithinProject(
      plan.projectRoot,
      join(plan.projectRoot, name),
      `${name} copy source`,
    );
    if (!existsSync(source)) throw new Error(`Required workspace directory is missing: ${source}`);
    cpSync(source, join(workspace, name), { recursive: true });
  }
  for (const name of COPIED_FILES) {
    const source = assertPathWithinProject(
      plan.projectRoot,
      join(plan.projectRoot, name),
      `${name} copy source`,
    );
    if (existsSync(source)) copyFileSync(source, join(workspace, name));
  }
}

function prepareWorkspaces(plan) {
  if (existsSync(plan.runRoot)) {
    throw new Error(`Refusing to overwrite existing E2E run root: ${plan.runRoot}`);
  }
  mkdirSync(plan.runRoot, { recursive: true });
  writeFileSync(
    join(plan.runRoot, RUN_MARKER_NAME),
    `${JSON.stringify({
      owner: RUN_MARKER_OWNER,
      pid: process.pid,
      projectRoot: resolve(plan.projectRoot),
      runRoot: plan.runRoot,
      version: 1,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  for (const { cwd } of plan.processes) materializeWorkspace(plan, cwd);
}

function cleanupRunRoot(plan) {
  if (existsSync(plan.runRoot)) {
    removeOwnedRunRoot(plan.projectRoot, plan.runRoot, {
      allowCurrentProcess: true,
    });
  }
}

function spawnManaged(args, environment, cwd) {
  const npmCli = environment.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is required to start isolated E2E app servers");
  }
  return spawn(process.execPath, [npmCli, ...args], {
    cwd,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
  });
}

async function waitUntilReady(child, url) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${url} process exited before becoming ready`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status > 0) return;
    } catch {
      // The server is still compiling or binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function terminateTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

let stopAll;

async function main() {
  const arguments_ = process.argv.slice(2);
  const projectRoot = process.cwd();
  const cleanupRunIndex = arguments_.indexOf("--cleanup-owned-run");
  if (cleanupRunIndex !== -1) {
    const runName = arguments_[cleanupRunIndex + 1];
    if (!runName) throw new Error("--cleanup-owned-run requires an exact run directory name");
    const removed = removeOwnedRunRoot(
      projectRoot,
      join(projectRoot, ".next", "e2e-apps", runName),
      { allowLegacy: true },
    );
    if (!removed) throw new Error(`Owned E2E run is still live: ${runName}`);
    return;
  }
  const plan = createPlan(arguments_, process.env, projectRoot);
  if (arguments_.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(publicPlan(plan))}\n`);
    return;
  }

  const children = [];
  let shuttingDown = false;
  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of [...children].reverse()) terminateTree(child);
    cleanupRunRoot(plan);
    process.exit(exitCode);
  };
  stopAll = shutdown;
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("exit", () => {
    if (!shuttingDown) cleanupRunRoot(plan);
  });

  cleanupStaleRunRoots(plan.projectRoot);
  prepareWorkspaces(plan);
  process.stdout.write(`[isolated-e2e] prepared ${plan.runRoot}\n`);

  for (const processPlan of plan.processes) {
    const child = spawnManaged(
      processPlan.args,
      processPlan.environment,
      processPlan.cwd,
    );
    children.push(child);
    child.once("error", (error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      shutdown(1);
    });
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      process.stderr.write(
        `${processPlan.name} app exited with code ${code ?? "null"} and signal ${signal ?? "none"}\n`,
      );
      shutdown(1);
    });
    await waitUntilReady(child, processPlan.readinessUrl);
    process.stdout.write(`[isolated-e2e] ${processPlan.name} ready at ${processPlan.url}\n`);
  }

  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  if (stopAll) stopAll(1);
  else process.exit(1);
});
