import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const COORDINATION_TIMEOUT_CODES = new Set(["55P03", "57014"]);
const DEFAULT_DB_CLIENT_PATH = fileURLToPath(new URL("../../db/client.ts", import.meta.url));

const require = createRequire(import.meta.url);

type TransactionDatabase = {
  transaction<T>(callback: (tx: { execute: (statement: ReturnType<typeof sql>) => Promise<unknown> }) => Promise<T>): Promise<T>;
};

export type CatalogAssetCoordinator = {
  withDigestLock<T>(digest: string, action: () => Promise<T>): Promise<T>;
  withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T>;
};

export class CatalogAssetCoordinationError extends Error {
  constructor(
    public readonly code:
      | "CATALOG_ASSET_COORDINATION_TIMEOUT"
      | "CATALOG_ASSET_COORDINATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CatalogAssetCoordinationError";
  }
}

type PostgresCoordinatorOptions = {
  db?: TransactionDatabase;
  lockTimeoutMs?: number;
};

function toLockKey(scope: "digest" | "run", value: string) {
  return `catalog-assets:${scope}:${value}`;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.cause?.code === "string"
        ? candidate.cause.code
        : null;

  return code !== null && COORDINATION_TIMEOUT_CODES.has(code);
}

function toLockTimeoutValue(lockTimeoutMs: number) {
  const timeoutMs = Math.max(1, Math.floor(lockTimeoutMs));
  return `${timeoutMs}ms`;
}

export function createPostgresCatalogAssetCoordinator(
  options: PostgresCoordinatorOptions = {},
): CatalogAssetCoordinator {
  const database =
    options.db ??
    (require(DEFAULT_DB_CLIENT_PATH) as {
      db: TransactionDatabase;
    }).db;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  async function withLock<T>(
    scope: "digest" | "run",
    value: string,
    action: () => Promise<T>,
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

        callbackStarted = true;
        return await action();
      });
    } catch (error) {
      if (callbackStarted) {
        throw error;
      }
      if (isTimeoutError(error)) {
        throw new CatalogAssetCoordinationError(
          "CATALOG_ASSET_COORDINATION_TIMEOUT",
          "catalog asset coordination timed out",
        );
      }
      throw new CatalogAssetCoordinationError(
        "CATALOG_ASSET_COORDINATION_FAILED",
        "catalog asset coordination failed",
      );
    }
  }

  return {
    async withDigestLock<T>(digest: string, action: () => Promise<T>) {
      return await withLock("digest", digest, action);
    },
    async withRunLock<T>(runId: string, action: () => Promise<T>) {
      return await withLock("run", runId, action);
    },
  };
}
