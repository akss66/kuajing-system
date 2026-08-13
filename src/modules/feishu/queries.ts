import { and, eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  adminUsers,
  authUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  skus,
} from "@/db/schema";

type DatabaseLike = DbTransaction | typeof db;

export async function findActiveSuperAdminMirrorId(
  database: DatabaseLike,
  actorUserId: string,
) {
  const [actor] = await database
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(
      and(
        eq(authUsers.id, actorUserId),
        eq(authUsers.role, "super_admin"),
      ),
    )
    .limit(1);
  if (!actor) {
    throw new Error("Super admin actor is not authorized");
  }

  const [mirror] = await database
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.loginIdentifier, actor.email),
        eq(adminUsers.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!mirror) {
    throw new Error("Super admin mirror profile was not active");
  }

  return mirror.id;
}

export async function countSkus(database: DatabaseLike) {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(skus);
  return row?.count ?? 0;
}

export async function findMigrationRunForUpdate(
  tx: DbTransaction,
  runId: string,
) {
  const [run] = await tx
    .select()
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.id, runId))
    .for("update")
    .limit(1);
  return run ?? null;
}

export async function findMigrationRun(
  database: DatabaseLike,
  runId: string,
) {
  const [run] = await database
    .select()
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.id, runId))
    .limit(1);
  return run ?? null;
}

export async function importedMigrationExists(
  database: DatabaseLike,
  excludingRunId?: string,
) {
  const conditions = excludingRunId
    ? and(
        eq(feishuCargoMigrationRuns.status, "IMPORTED"),
        sql`${feishuCargoMigrationRuns.id} <> ${excludingRunId}::uuid`,
      )
    : eq(feishuCargoMigrationRuns.status, "IMPORTED");

  const [run] = await database
    .select({ id: feishuCargoMigrationRuns.id })
    .from(feishuCargoMigrationRuns)
    .where(conditions)
    .limit(1);
  return Boolean(run);
}

export async function catalogAssetExistsForDigest(
  tx: DbTransaction,
  contentSha256: string,
) {
  const [asset] = await tx
    .select({
      byteSize: catalogAssets.byteSize,
      contentSha256: catalogAssets.contentSha256,
      id: catalogAssets.id,
      mimeType: catalogAssets.mimeType,
      originalFileName: catalogAssets.originalFileName,
      storageKey: catalogAssets.storageKey,
    })
    .from(catalogAssets)
    .where(eq(catalogAssets.contentSha256, contentSha256))
    .limit(1);
  return asset ?? null;
}
