import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production worker watchdog", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/worker-watchdog.sh"),
    "utf8",
  );

  it("forces shell scripts to LF in repository exports", () => {
    const result = spawnSync(
      "git",
      ["check-attr", "text", "eol", "--", "scripts/worker-watchdog.sh"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("scripts/worker-watchdog.sh: text: set");
    expect(result.stdout).toContain("scripts/worker-watchdog.sh: eol: lf");
  });

  it("only recreates the unhealthy worker without touching web or postgres", () => {
    expect(script).toContain("unhealthy)");
    expect(script).toContain("--no-build --no-deps --force-recreate worker");
    expect(script).not.toMatch(/force-recreate (?:postgres|web)/);
    expect(script).not.toMatch(/(?:restart|stop|down) (?:postgres|web)/);
    expect(script).toContain('replacement_id" = "$container_id');
    expect(script).toContain("worker recreation did not produce a new container");
    expect(script).toContain('wait_for_worker_healthy "$replacement_id"');
  });

  it("starts a missing worker from the immutable image and verifies it becomes healthy", () => {
    expect(script).toContain("worker container is missing; starting immutable release worker");
    expect(script).toContain("-d --no-build --no-deps worker");
    expect(script).toContain('wait_for_worker_healthy "$replacement_id"');
    expect(script).toContain("started missing worker");
  });

  it("does not recreate starting or unexpectedly unhealthy-shaped services", () => {
    expect(script).toContain("healthy|starting)");
    expect(script).toContain("unexpected worker health '$health'; no automatic action taken");
  });

  it("bounds health verification and never targets web or postgres", () => {
    expect(script).toContain("wait_for_worker_healthy()");
    expect(script).toContain("worker did not become healthy within the watchdog window");
    expect(script).not.toMatch(/(?:up|restart|stop|down)[^\n]*(?:postgres|web)/);
  });

  it("overrides any stale compose env-file tag with one validated release identity", () => {
    expect(script).toContain("export APP_VERSION RELEASE_SHA");
    expect(script).toContain("APP_VERSION must be a 7-40 character lowercase Git SHA");
    expect(script).toContain("RELEASE_SHA must be a full 40 character lowercase Git SHA");
    expect(script).toContain("APP_VERSION and RELEASE_SHA identify different commits");
  });

  it("exports the compose application env file for every compose invocation", () => {
    expect(script).toContain('APP_ENV_FILE="$compose_env_file"');
    expect(script).toContain("export APP_VERSION RELEASE_SHA APP_ENV_FILE");
  });

  it(
    "recovers a missing worker and waits for health without targeting other services",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "worker-watchdog-"));
      try {
        const fakeDocker = join(directory, "docker");
        const composeFile = join(directory, "compose.yaml");
        const composeEnvFile = join(directory, "production.env");
        const logFile = join(directory, "docker.log");
        const startedFile = join(directory, "worker-started");
        const inspectCountFile = join(directory, "inspect-count");
        const toShellPath = (path: string) =>
          process.platform === "win32"
            ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`
            : path;
        writeFileSync(composeFile, "services: {}\n", "utf8");
        writeFileSync(composeEnvFile, "SAFE_PLACEHOLDER=1\n", "utf8");
        writeFileSync(
          fakeDocker,
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ]; then
  if [ "$APP_ENV_FILE" != "$EXPECTED_APP_ENV_FILE" ]; then
    printf '%s\\n' "missing APP_ENV_FILE for compose invocation: $*" >&2
    exit 9
  fi
  case " $* " in
    *" ps -q worker "*)
      if [ -f "$FAKE_WORKER_STARTED" ]; then printf '%s\\n' 'worker-new'; fi
      ;;
    *" up "*" worker ")
      : > "$FAKE_WORKER_STARTED"
      ;;
  esac
elif [ "$1" = "inspect" ]; then
  count=0
  if [ -f "$FAKE_INSPECT_COUNT" ]; then count=$(cat "$FAKE_INSPECT_COUNT"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$FAKE_INSPECT_COUNT"
  if [ "$count" -eq 1 ]; then printf '%s\\n' 'starting'; else printf '%s\\n' 'healthy'; fi
fi
`,
          "utf8",
        );
        chmodSync(fakeDocker, 0o755);

        const shell =
          process.platform === "win32"
            ? "C:\\Program Files\\Git\\bin\\sh.exe"
            : "sh";
        const result = spawnSync(
          shell,
          [
            toShellPath(resolve(process.cwd(), "scripts/worker-watchdog.sh")),
            toShellPath(composeFile),
            toShellPath(composeEnvFile),
            "abcdef1",
            "abcdef1234567890abcdef1234567890abcdef12",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              FAKE_DOCKER_LOG: toShellPath(logFile),
              FAKE_INSPECT_COUNT: toShellPath(inspectCountFile),
              FAKE_WORKER_STARTED: toShellPath(startedFile),
              EXPECTED_APP_ENV_FILE: toShellPath(composeEnvFile),
              PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
        );

        expect(result.status, result.stderr).toBe(0);
        const commands = readFileSync(logFile, "utf8").split(/\r?\n/);
        const upCommands = commands.filter((command) => command.includes(" up "));
        expect(upCommands).toHaveLength(1);
        expect(upCommands[0]).toContain("-d --no-build --no-deps worker");
        expect(upCommands[0]).not.toMatch(/\b(?:web|postgres)\b/);
        expect(commands.filter((command) => command.startsWith("inspect "))).toHaveLength(2);
        expect(result.stderr).toContain("started missing worker worker-new");
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
