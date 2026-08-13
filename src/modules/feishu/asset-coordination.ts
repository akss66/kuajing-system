import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 50;
const COORDINATION_TIMEOUT_CODES = new Set(["55P03", "57014"]);
const CONNECTION_LOST_CODES = new Set([
  "08000",
  "08003",
  "08006",
  "57P01",
  "57P02",
  "ECONNRESET",
  "EPIPE",
  "CONNECTION_CLOSED",
]);
const DEFAULT_DB_CLIENT_PATH = fileURLToPath(new URL("../../db/client.ts", import.meta.url));

const require = createRequire(import.meta.url);

type TransactionDatabase = {
  transaction<T>(
    callback: (tx: { execute: (statement: ReturnType<typeof sql>) => Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
};

export type CatalogAssetLockGuard = {
  assertHeld(): Promise<void>;
  signal: AbortSignal;
};

export type CatalogAssetCoordinator = {
  withDigestLock<T>(digest: string, action: (guard: CatalogAssetLockGuard) => Promise<T>): Promise<T>;
  withRunLock<T>(runId: string, action: (guard: CatalogAssetLockGuard) => Promise<T>): Promise<T>;
};

export class CatalogAssetCoordinationError extends Error {
  constructor(
    public readonly code:
      | "CATALOG_ASSET_COORDINATION_TIMEOUT"
      | "CATALOG_ASSET_COORDINATION_FAILED"
      | "CATALOG_ASSET_COORDINATION_LOST",
    message: string,
  ) {
    super(message);
    this.name = "CatalogAssetCoordinationError";
  }
}

type PostgresCoordinatorOptions = {
  db?: TransactionDatabase;
  heartbeatIntervalMs?: number;
  lockTimeoutMs?: number;
};

function toLockKey(scope: "digest" | "run", value: string) {
  return `catalog-assets:${scope}:${value}`;
}

function errorCodeOf(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate.code === "string") {
    return candidate.code;
  }
  if (typeof candidate.cause?.code === "string") {
    return candidate.cause.code;
  }
  return null;
}

function errorMessageOf(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function isTimeoutError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== null && COORDINATION_TIMEOUT_CODES.has(code);
}

function isConnectionLostError(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code !== null && CONNECTION_LOST_CODES.has(code)) {
    return true;
  }

  const message = errorMessageOf(error).toLowerCase();
  return (
    message.includes("connection") &&
    (message.includes("closed") || message.includes("terminated") || message.includes("broken"))
  );
}

function toLockTimeoutValue(lockTimeoutMs: number) {
  const timeoutMs = Math.max(1, Math.floor(lockTimeoutMs));
  return `${timeoutMs}ms`;
}

function createLockLostError() {
  return new CatalogAssetCoordinationError(
    "CATALOG_ASSET_COORDINATION_LOST",
    "catalog asset coordination lock was lost",
  );
}

export function createPostgresCatalogAssetCoordinator(
  options: PostgresCoordinatorOptions = {},
): CatalogAssetCoordinator {
  const database =
    options.db ??
    (require(DEFAULT_DB_CLIENT_PATH) as {
      db: TransactionDatabase;
    }).db;
  const heartbeatIntervalMs = Math.max(10, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  async function withLock<T>(
    scope: "digest" | "run",
    value: string,
    action: (guard: CatalogAssetLockGuard) => Promise<T>,
  ) {
    let callbackStarted = false;
    try {
      return await database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${toLockTimeoutValue(lockTimeoutMs)}, true)`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${toLockKey(scope, value)}, 0))`,
        );

        const abortController = new AbortController();
        let heartbeatError: CatalogAssetCoordinationError | null = null;
        let heartbeatStopped = false;
        let heartbeatTimer: NodeJS.Timeout | null = null;
        let heartbeatInFlight: Promise<void> | null = null;
        let resolveHeartbeatStopped: (() => void) | null = null;
        const heartbeatStoppedPromise = new Promise<void>((resolve) => {
          resolveHeartbeatStopped = resolve;
        });

        let validationChain = Promise.resolve();

        const stopHeartbeat = () => {
          heartbeatStopped = true;
          if (heartbeatTimer) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (!heartbeatInFlight) {
            resolveHeartbeatStopped?.();
          }
        };

        const markLost = (error: unknown) => {
          if (heartbeatError) {
            return;
          }
          heartbeatError =
            error instanceof CatalogAssetCoordinationError ? error : createLockLostError();
          abortController.abort(heartbeatError);
          stopHeartbeat();
        };

        const throwIfLost = () => {
          if (heartbeatError) {
            throw heartbeatError;
          }
          if (abortController.signal.aborted) {
            throw abortController.signal.reason instanceof Error
              ? abortController.signal.reason
              : createLockLostError();
          }
        };

        const validateTransaction = async () => {
          throwIfLost();

          const validationTask = validationChain.then(async () => {
            await tx.execute(sql`select 1`);
          });
          validationChain = validationTask.catch(() => undefined);

          try {
            await validationTask;
          } catch (error) {
            markLost(error);
            throw throwIfLost();
          }

          throwIfLost();
        };

        const guard: CatalogAssetLockGuard = {
          signal: abortController.signal,
          async assertHeld() {
            await validateTransaction();
          },
        };

        const scheduleHeartbeat = () => {
          if (heartbeatStopped || heartbeatError) {
            stopHeartbeat();
            return;
          }
          heartbeatTimer = setTimeout(() => {
            heartbeatInFlight = runHeartbeat();
          }, heartbeatIntervalMs);
          heartbeatTimer.unref?.();
        };

        const runHeartbeat = async () => {
          try {
            await validateTransaction();
          } catch (error) {
            markLost(error);
            return;
          } finally {
            heartbeatInFlight = null;
            if (heartbeatStopped) {
              resolveHeartbeatStopped?.();
            }
          }

          scheduleHeartbeat();
        };

        callbackStarted = true;
        scheduleHeartbeat();

        try {
          await guard.assertHeld();
          const result = await action(guard);
          await guard.assertHeld();
          return result;
        } catch (error) {
          if (isConnectionLostError(error)) {
            throw createLockLostError();
          }
          throw error;
        } finally {
          stopHeartbeat();
          await heartbeatStoppedPromise;
        }
      });
    } catch (error) {
      if (error instanceof CatalogAssetCoordinationError) {
        throw error;
      }
      if (!callbackStarted && isTimeoutError(error)) {
        throw new CatalogAssetCoordinationError(
          "CATALOG_ASSET_COORDINATION_TIMEOUT",
          "catalog asset coordination timed out",
        );
      }
      if (callbackStarted && isConnectionLostError(error)) {
        throw createLockLostError();
      }
      if (!callbackStarted) {
        throw new CatalogAssetCoordinationError(
          "CATALOG_ASSET_COORDINATION_FAILED",
          "catalog asset coordination failed",
        );
      }
      throw error;
    }
  }

  return {
    async withDigestLock<T>(digest: string, action: (guard: CatalogAssetLockGuard) => Promise<T>) {
      return await withLock("digest", digest, action);
    },
    async withRunLock<T>(runId: string, action: (guard: CatalogAssetLockGuard) => Promise<T>) {
      return await withLock("run", runId, action);
    },
  };
}
