import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const detectedTempDirectory = tmpdir();
const safeTempDirectory = detectedTempDirectory.includes("undefined")
  ? resolve(process.cwd(), "node_modules", ".cache")
  : detectedTempDirectory;
export const DEFAULT_WORKER_HEALTH_FILE = resolve(
  safeTempDirectory,
  "tongzhouxing-worker-health.json",
);
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

export type WorkerHealthState =
  | "STARTING"
  | "READY"
  | "DEGRADED"
  | "STOPPING";

export interface WorkerHealthSnapshot {
  version: 1;
  pid: number;
  state: WorkerHealthState;
  startedAt: string;
  lastHeartbeatAt: string;
}

export type WorkerHealthAssessment =
  | { healthy: true; code: "HEALTHY" }
  | {
      healthy: false;
      code:
        | "INVALID_HEARTBEAT"
        | "HEARTBEAT_STALE"
        | "NOT_READY"
        | "PROCESS_MISSING"
        | "SCHEDULER_INACTIVE"
        | "STOPPING";
    };

type SchedulerWorker = {
  name: string;
  state: "created" | "active" | "stopping" | "stopped";
  lastError?: object | null;
};

export function areExpectedWorkersActive(
  workers: readonly SchedulerWorker[],
  expectedQueueNames: readonly string[],
): boolean {
  return expectedQueueNames.every((queueName) =>
    workers.some(
      (worker) => worker.name === queueName && worker.state === "active",
    ),
  );
}

export function assessWorkerHealth(
  snapshot: WorkerHealthSnapshot,
  options: {
    now: Date;
    maxHeartbeatAgeMs: number;
    isProcessAlive: (pid: number) => boolean;
  },
): WorkerHealthAssessment {
  const heartbeatAt = Date.parse(snapshot.lastHeartbeatAt);
  const heartbeatAgeMs = options.now.getTime() - heartbeatAt;
  if (
    !Number.isFinite(heartbeatAt) ||
    !Number.isInteger(snapshot.pid) ||
    snapshot.pid <= 0 ||
    heartbeatAgeMs < -5_000
  ) {
    return { healthy: false, code: "INVALID_HEARTBEAT" };
  }
  if (!options.isProcessAlive(snapshot.pid)) {
    return { healthy: false, code: "PROCESS_MISSING" };
  }
  if (heartbeatAgeMs > options.maxHeartbeatAgeMs) {
    return { healthy: false, code: "HEARTBEAT_STALE" };
  }

  switch (snapshot.state) {
    case "READY":
      return { healthy: true, code: "HEALTHY" };
    case "STARTING":
      return { healthy: false, code: "NOT_READY" };
    case "DEGRADED":
      return { healthy: false, code: "SCHEDULER_INACTIVE" };
    case "STOPPING":
      return { healthy: false, code: "STOPPING" };
  }
}

function isWorkerHealthSnapshot(value: unknown): value is WorkerHealthSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerHealthSnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.pid === "number" &&
    ["STARTING", "READY", "DEGRADED", "STOPPING"].includes(
      candidate.state ?? "",
    ) &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.lastHeartbeatAt === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readWorkerHealthSnapshot(
  filePath = process.env.WORKER_HEALTH_FILE || DEFAULT_WORKER_HEALTH_FILE,
): WorkerHealthSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isWorkerHealthSnapshot(parsed)) {
    throw new Error("worker health file has an invalid shape");
  }
  return parsed;
}

export function checkWorkerHealth(
  options: {
    filePath?: string;
    now?: Date;
    maxHeartbeatAgeMs?: number;
    processProbe?: (pid: number) => boolean;
  } = {},
): WorkerHealthAssessment {
  try {
    return assessWorkerHealth(
      readWorkerHealthSnapshot(options.filePath),
      {
        now: options.now ?? new Date(),
        maxHeartbeatAgeMs:
          options.maxHeartbeatAgeMs ?? DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS,
        isProcessAlive: options.processProbe ?? isProcessAlive,
      },
    );
  } catch {
    return { healthy: false, code: "INVALID_HEARTBEAT" };
  }
}

export function createWorkerHealthMonitor(options: {
  filePath?: string;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  pid?: number;
  schedulerProbe: () => boolean;
}) {
  const filePath =
    options.filePath ??
    process.env.WORKER_HEALTH_FILE ??
    DEFAULT_WORKER_HEALTH_FILE;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const startedAt = now().toISOString();
  let state: WorkerHealthState = "STARTING";
  let timer: NodeJS.Timeout | undefined;

  const writeSnapshot = () => {
    const snapshot: WorkerHealthSnapshot = {
      version: 1,
      pid,
      state,
      startedAt,
      lastHeartbeatAt: now().toISOString(),
    };
    const temporaryPath = `${filePath}.${pid}.tmp`;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
  };

  const heartbeat = () => {
    if (state === "READY" || state === "DEGRADED") {
      try {
        state = options.schedulerProbe() ? "READY" : "DEGRADED";
      } catch {
        state = "DEGRADED";
      }
    }
    writeSnapshot();
  };

  return {
    start() {
      writeSnapshot();
      timer = setInterval(() => {
        try {
          heartbeat();
        } catch {
          // A failed write intentionally leaves the last heartbeat stale so an
          // orchestrator or external monitor can replace this worker.
        }
      }, heartbeatIntervalMs);
      timer.unref?.();
    },
    markReady() {
      state = "READY";
      writeSnapshot();
    },
    markStopping() {
      state = "STOPPING";
      writeSnapshot();
    },
    heartbeat,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

function runCliHealthcheck() {
  const result = checkWorkerHealth();
  if (!result.healthy) {
    console.error(`[worker-health] ${result.code}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) {
  runCliHealthcheck();
}
