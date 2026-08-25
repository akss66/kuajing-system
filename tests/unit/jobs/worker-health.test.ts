import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessWorkerHealth,
  areExpectedWorkersActive,
  checkWorkerHealth,
  createWorkerHealthMonitor,
  type WorkerHealthSnapshot,
} from "@/jobs/worker-health";

const now = new Date("2026-08-20T10:00:00.000Z");

function snapshot(
  overrides: Partial<WorkerHealthSnapshot> = {},
): WorkerHealthSnapshot {
  return {
    version: 1,
    pid: 42,
    state: "READY",
    startedAt: "2026-08-20T09:55:00.000Z",
    lastHeartbeatAt: "2026-08-20T09:59:50.000Z",
    ...overrides,
  };
}

describe("assessWorkerHealth", () => {
  it("accepts a ready worker whose process and event loop are progressing", () => {
    expect(
      assessWorkerHealth(snapshot(), {
        now,
        maxHeartbeatAgeMs: 45_000,
        isProcessAlive: () => true,
      }),
    ).toEqual({ healthy: true, code: "HEALTHY" });
  });

  it.each([
    ["STARTING", "NOT_READY"],
    ["DEGRADED", "SCHEDULER_INACTIVE"],
    ["STOPPING", "STOPPING"],
  ] as const)("rejects the %s lifecycle state", (state, code) => {
    expect(
      assessWorkerHealth(snapshot({ state }), {
        now,
        maxHeartbeatAgeMs: 45_000,
        isProcessAlive: () => true,
      }),
    ).toEqual({ healthy: false, code });
  });

  it("rejects a ready worker whose event loop heartbeat is stale", () => {
    expect(
      assessWorkerHealth(
        snapshot({ lastHeartbeatAt: "2026-08-20T09:58:00.000Z" }),
        {
          now,
          maxHeartbeatAgeMs: 45_000,
          isProcessAlive: () => true,
        },
      ),
    ).toEqual({ healthy: false, code: "HEARTBEAT_STALE" });
  });

  it("rejects a fresh heartbeat when the recorded worker process is gone", () => {
    expect(
      assessWorkerHealth(snapshot(), {
        now,
        maxHeartbeatAgeMs: 45_000,
        isProcessAlive: () => false,
      }),
    ).toEqual({ healthy: false, code: "PROCESS_MISSING" });
  });
});

describe("checkWorkerHealth", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing heartbeat from malformed heartbeat data", () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-health-read-"));
    temporaryDirectories.push(directory);

    expect(
      checkWorkerHealth({
        filePath: join(directory, "missing.json"),
        now,
        processProbe: () => true,
      }),
    ).toEqual({ healthy: false, code: "HEARTBEAT_MISSING" });
  });
});

describe("areExpectedWorkersActive", () => {
  const expected = ["expire-orders", "jifeng-cycle"];

  it("does not treat a completed job's recorded business failure as worker death", () => {
    expect(
      areExpectedWorkersActive(
        [
          { name: "expire-orders", state: "active", lastError: null },
          {
            name: "jifeng-cycle",
            state: "active",
            lastError: { message: "third-party request failed" },
          },
        ],
        expected,
      ),
    ).toBe(true);
  });

  it("rejects a scheduler with a missing or stopped queue worker", () => {
    expect(
      areExpectedWorkersActive(
        [
          { name: "expire-orders", state: "active", lastError: null },
          { name: "jifeng-cycle", state: "stopped", lastError: null },
        ],
        expected,
      ),
    ).toBe(false);
  });
});

describe("createWorkerHealthMonitor", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes lifecycle and scheduler state without exposing task errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-health-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "health.json");
    let schedulerActive = true;
    const monitor = createWorkerHealthMonitor({
      filePath,
      heartbeatIntervalMs: 60_000,
      now: () => now,
      pid: 42,
      schedulerProbe: () => schedulerActive,
    });
    const readState = () =>
      (JSON.parse(readFileSync(filePath, "utf8")) as WorkerHealthSnapshot).state;

    monitor.start();
    expect(readState()).toBe("STARTING");

    monitor.markReady();
    expect(readState()).toBe("READY");

    schedulerActive = false;
    monitor.heartbeat();
    expect(readState()).toBe("DEGRADED");

    schedulerActive = true;
    monitor.heartbeat();
    expect(readState()).toBe("READY");

    monitor.markStopping();
    expect(readState()).toBe("STOPPING");
    monitor.stop();
  });
});
