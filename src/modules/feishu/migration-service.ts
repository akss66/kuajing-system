import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  catalogAssets,
  feishuCargoMigrationRuns,
  inventoryBalances,
  inventoryMovements,
  products,
  skus,
} from "@/db/schema";
import { FeishuApiError } from "@/integrations/feishu/client";
import type { FeishuIntegrationConfig } from "@/integrations/feishu/config";

import { createCatalogAssetStorage } from "./asset-storage";
import { parseLegacyCargoSheet } from "./cargo-parser";
import type {
  MigrationIssue,
  NormalizedCargoRow,
  ParsedCargoRow,
  TemporaryAssetManifest,
} from "./cargo-types";
import { enqueueCargoSyncEvent } from "./outbox";
import {
  catalogAssetExistsForDigest,
  countSkus,
  findAdminMirrorIdForActor,
  findMigrationRunForUpdate,
  importedMigrationExists,
} from "./queries";
import {
  readFeishuSourceSnapshot,
  type FeishuSourcePort,
  type FeishuSourceSelectionRequired,
} from "./source-reader";

const IMPORT_LOCK_TIMEOUT_MS = 10_000;
const IMPORT_SINGLETON_LOCK_KEY = "feishu-cargo-migration:singleton-import";
const IMPORT_REASON = "Initial Feishu cargo import";

type PreflightReadyResult = {
  runId: string;
  status: "PREFLIGHT_BLOCKED" | "PREFLIGHT_READY";
};

type ConfirmResult = {
  imageCount: number;
  productCount: number;
  skuCount: number;
};

type MigrationServiceOptions = {
  assetDir?: string;
};

type DownloadedRowAsset = {
  manifest: TemporaryAssetManifest;
  normalizedRow: NormalizedCargoRow;
};

type PreparedConfirmation = {
  normalizedRows: NormalizedCargoRow[];
  sourceDigest: string;
  temporaryAssets: TemporaryAssetManifest[];
};

type CatalogAssetRecord = {
  contentSha256: string;
  id: string;
  storageKey: string;
};

type ExistingMigrationRun = typeof feishuCargoMigrationRuns.$inferSelect;
type DatabaseLike = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

type SourceValidationResult =
  | FeishuSourceSelectionRequired
  | {
      issue: MigrationIssue;
      status: "PREFLIGHT_BLOCKED";
    }
  | ({
      issues: MigrationIssue[];
      normalizedRows: NormalizedCargoRow[];
      sourceDigest: string;
      sourceRevision: number;
      sourceSheetId: string;
      sourceSpreadsheetHash: string;
      summary: {
        imageCount: number;
        productCount: number;
        skuCount: number;
        totalQuantity: number;
      };
      temporaryAssets: TemporaryAssetManifest[];
    } & { status: "PREFLIGHT_BLOCKED" | "PREFLIGHT_READY" });

export class FeishuCargoMigrationError extends Error {
  constructor(
    public readonly code:
      | "ACTOR_NOT_FOUND"
      | "ALREADY_IMPORTED"
      | "CATALOG_NOT_EMPTY"
      | "FORBIDDEN_SUPER_ADMIN"
      | "MIGRATION_NOT_CONFIRMABLE"
      | "MIGRATION_NOT_FOUND"
      | "SOURCE_STALE",
    message: string,
  ) {
    super(message);
    this.name = "FeishuCargoMigrationError";
  }
}

function assertSuperAdmin(actor: { kind: string }) {
  if (actor.kind !== "SUPER_ADMIN") {
    throw new FeishuCargoMigrationError(
      "FORBIDDEN_SUPER_ADMIN",
      "Only the super admin can run the Feishu cargo migration",
    );
  }
}

async function roundTripJsonb<T>(database: DatabaseLike, value: T): Promise<T> {
  const rows = await database.execute<{ value: T }>(sql`
    select ${JSON.stringify(value)}::jsonb as value
  `);
  return rows[0]?.value ?? value;
}

async function createCanonicalDigest(
  database: DatabaseLike,
  rows: NormalizedCargoRow[],
) {
  const normalized = await roundTripJsonb(database, rows);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function sanitizeDownloadIssue(input: {
  error: unknown;
  sourceRowNumber: number;
}): MigrationIssue {
  const error = input.error;
  if (error instanceof FeishuApiError) {
    return {
      code: "SOURCE_IMAGE_DOWNLOAD_FAILED",
      message: error.retryable
        ? "Source image download failed and can be retried"
        : "Source image download failed",
      severity: error.retryable ? "RETRYABLE" : "BLOCKING",
      sourceRowNumber: input.sourceRowNumber,
    };
  }

  return {
    code: "SOURCE_IMAGE_DOWNLOAD_FAILED",
    message: "Source image download failed",
    severity: "BLOCKING",
    sourceRowNumber: input.sourceRowNumber,
  };
}

function normalizeDownloadedRow(
  row: ParsedCargoRow,
  manifest: TemporaryAssetManifest,
): NormalizedCargoRow {
  return {
    color: row.color,
    combination: row.combination,
    defaultUnitPriceFen: row.defaultUnitPriceFen,
    imageContentSha256: manifest.contentSha256,
    imageTemporaryKey: manifest.temporaryKey,
    inheritedFrom: row.inheritedFrom,
    linkText: row.linkText,
    productGroupKey: row.productGroupKey,
    productName: row.productName,
    productUrl: row.productUrl,
    saleStatus: row.saleStatus,
    skuCode: row.skuCode,
    skuName: row.skuName,
    sourceRowNumber: row.sourceRowNumber,
    specification: row.specification,
    totalQuantity: row.totalQuantity,
    weightGrams: row.weightGrams,
  };
}

async function downloadAndStageRowAssets(input: {
  assetDir?: string;
  client: FeishuSourcePort;
  rows: ParsedCargoRow[];
  runId: string;
}) {
  const storage = createCatalogAssetStorage({ assetDir: input.assetDir });
  const downloaded: DownloadedRowAsset[] = [];

  try {
    for (const row of input.rows) {
      let media;
      try {
        media = await input.client.downloadMedia(row.imageFileToken);
      } catch (error) {
        throw {
          cause: error,
          sourceRowNumber: row.sourceRowNumber,
        };
      }
      const manifest = await storage.stageCatalogAsset({
        bytes: media.bytes,
        contentType: media.contentType,
        originalFileName: media.fileName ?? `${row.skuCode}.bin`,
        runId: input.runId,
        skuCode: row.skuCode,
      });
      downloaded.push({
        manifest,
        normalizedRow: normalizeDownloadedRow(row, manifest),
      });
    }
    return downloaded;
  } catch (error) {
    await storage.discardStagedAssets(input.runId).catch(() => undefined);
    throw error;
  }
}

async function validateAndPrepareSource(input: {
  assetDir?: string;
  client: FeishuSourcePort;
  config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  runId: string;
}): Promise<SourceValidationResult> {
  const snapshot = await readFeishuSourceSnapshot({
    client: input.client,
    config: input.config,
  });
  if ("status" in snapshot) {
    return snapshot;
  }
  const sourceSnapshot = snapshot;

  const parsed = parseLegacyCargoSheet(sourceSnapshot.values);
  const blockingParseIssues = parsed.issues.filter((issue) => issue.severity === "BLOCKING");
  if (blockingParseIssues.length > 0) {
    return {
      issues: parsed.issues,
      normalizedRows: [],
      sourceDigest: await createCanonicalDigest(db, []),
      sourceRevision: sourceSnapshot.revision,
      sourceSheetId: sourceSnapshot.selectedSheet.sheetId,
      sourceSpreadsheetHash: sourceSnapshot.spreadsheetTokenHash,
      status: "PREFLIGHT_BLOCKED",
      summary: parsed.summary,
      temporaryAssets: [],
    };
  }

  let stagedAssets: DownloadedRowAsset[];
  try {
    stagedAssets = await downloadAndStageRowAssets({
      assetDir: input.assetDir,
      client: input.client,
      rows: parsed.rows,
      runId: input.runId,
    });
  } catch (error) {
    return {
      issue: sanitizeDownloadIssue({
        error:
          error && typeof error === "object" && "cause" in error
            ? (error as { cause: unknown }).cause
            : error,
        sourceRowNumber:
          error && typeof error === "object" && "sourceRowNumber" in error
            ? Number((error as { sourceRowNumber: unknown }).sourceRowNumber)
            : parsed.rows[0]?.sourceRowNumber ?? 1,
      }),
      status: "PREFLIGHT_BLOCKED",
    };
  }

  const normalizedRows = stagedAssets.map((entry) => entry.normalizedRow);
  const sourceDigest = await createCanonicalDigest(db, normalizedRows);
  const temporaryAssets = stagedAssets.map((entry) => entry.manifest);
  return {
    issues: parsed.issues,
    normalizedRows,
    sourceDigest,
    sourceRevision: sourceSnapshot.revision,
    sourceSheetId: sourceSnapshot.selectedSheet.sheetId,
    sourceSpreadsheetHash: sourceSnapshot.spreadsheetTokenHash,
    status: "PREFLIGHT_READY",
    summary: parsed.summary,
    temporaryAssets,
  };
}

async function deletePublishedOrphanAssets(input: {
  assetDir?: string;
  storageKeys: string[];
}) {
  if (input.storageKeys.length === 0) {
    return;
  }

  const uniqueKeys = [...new Set(input.storageKeys)].sort();
  if (uniqueKeys.length === 0) {
    return;
  }

  const referenced = await db
    .select({ storageKey: catalogAssets.storageKey })
    .from(catalogAssets)
    .where(inArray(catalogAssets.storageKey, uniqueKeys));
  const referencedKeys = new Set(referenced.map((asset) => asset.storageKey));
  const assetDir = input.assetDir ?? process.env.CATALOG_ASSET_DIR ?? "/app/data/catalog-assets";

  for (const storageKey of uniqueKeys) {
    if (referencedKeys.has(storageKey)) {
      continue;
    }
    await rm(join(assetDir, storageKey), { force: true }).catch(() => undefined);
    await rm(join(assetDir, dirname(storageKey)), { force: true }).catch(() => undefined);
  }
}

async function ensureCatalogAssetRecord(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  manifest: TemporaryAssetManifest,
  storageKey: string,
): Promise<CatalogAssetRecord> {
  const existing = await catalogAssetExistsForDigest(tx, manifest.contentSha256);
  if (existing) {
    return existing;
  }

  const [created] = await tx
    .insert(catalogAssets)
    .values({
      byteSize: manifest.byteSize,
      contentSha256: manifest.contentSha256,
      mimeType: manifest.mimeType,
      originalFileName: manifest.originalFileName,
      storageKey,
    })
    .returning();
  return created;
}

async function revalidateRunSource(input: {
  assetDir?: string;
  client: FeishuSourcePort;
  config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  run: ExistingMigrationRun;
}) {
  const snapshot = await readFeishuSourceSnapshot({
    client: input.client,
    config: input.config,
  });
  if ("status" in snapshot) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source sheet selection changed",
    );
  }
  const sourceSnapshot = snapshot;

  const parsed = parseLegacyCargoSheet(sourceSnapshot.values);
  if (parsed.issues.some((issue) => issue.severity === "BLOCKING")) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source content no longer matches the approved preflight",
    );
  }

  const normalizedRows = input.run.normalizedRowsJson as NormalizedCargoRow[];
  const reparsedRows = parsed.rows;
  if (sourceSnapshot.revision !== input.run.sourceRevision) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source revision changed after preflight",
    );
  }
  if (reparsedRows.length !== normalizedRows.length) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source row count changed after preflight",
    );
  }

  const reparsedWithoutImages: NormalizedCargoRow[] = [];
  const storage = createCatalogAssetStorage({ assetDir: input.assetDir });
  const replacementTemporaryAssets: TemporaryAssetManifest[] = [];

  for (let index = 0; index < reparsedRows.length; index += 1) {
    const row = reparsedRows[index];
    const existingRow = normalizedRows[index];
    const media = await input.client.downloadMedia(row.imageFileToken);
    const staged = await storage.stageCatalogAsset({
      bytes: media.bytes,
      contentType: media.contentType,
      originalFileName: media.fileName ?? `${row.skuCode}.bin`,
      runId: input.run.id,
      skuCode: row.skuCode,
    });
    replacementTemporaryAssets.push(staged);
    const normalizedRow = normalizeDownloadedRow(row, staged);
    reparsedWithoutImages.push(normalizedRow);

    if (
      staged.contentSha256 !== existingRow.imageContentSha256 ||
      row.skuCode !== existingRow.skuCode
    ) {
      throw new FeishuCargoMigrationError(
        "SOURCE_STALE",
        "Feishu source images changed after preflight",
      );
    }
  }

  if (
    (await createCanonicalDigest(db, reparsedWithoutImages)) !== input.run.sourceDigest
  ) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source content changed after preflight",
    );
  }

  return {
    normalizedRows,
    sourceDigest: input.run.sourceDigest,
    temporaryAssets: input.run.temporaryAssetsJson as TemporaryAssetManifest[],
  } satisfies PreparedConfirmation;
}

async function markRunStale(runId: string) {
  await db
    .update(feishuCargoMigrationRuns)
    .set({
      status: "STALE",
      updatedAt: new Date(),
    })
    .where(eq(feishuCargoMigrationRuns.id, runId));
}

function groupRowsByProduct(rows: NormalizedCargoRow[]) {
  const grouped = new Map<string, NormalizedCargoRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.productGroupKey) ?? [];
    group.push(row);
    grouped.set(row.productGroupKey, group);
  }
  return grouped;
}

export function createFeishuCargoMigrationService(options: MigrationServiceOptions = {}) {
  const storage = createCatalogAssetStorage({ assetDir: options.assetDir });

  async function createCargoPreflight(input: {
    actor: { kind: string; userId: string };
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken"> & {
      sourceSheetId: string;
    };
  }): Promise<PreflightReadyResult>;
  async function createCargoPreflight(input: {
    actor: { kind: string; userId: string };
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  }): Promise<FeishuSourceSelectionRequired | PreflightReadyResult>;
  async function createCargoPreflight(input: {
    actor: { kind: string; userId: string };
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  }): Promise<FeishuSourceSelectionRequired | PreflightReadyResult> {
    assertSuperAdmin(input.actor);
    const createdByAdminUserId = await findAdminMirrorIdForActor(db, input.actor.userId).catch(() => {
      throw new FeishuCargoMigrationError(
        "ACTOR_NOT_FOUND",
        "Super admin mirror profile was not found",
      );
    });
    const runId = crypto.randomUUID();
    const prepared = await validateAndPrepareSource({
      assetDir: options.assetDir,
      client: input.client,
      config: input.config,
      runId,
    });

    if ("status" in prepared && prepared.status === "SOURCE_SHEET_SELECTION_REQUIRED") {
      return prepared;
    }

    const issues =
      "issue" in prepared ? [prepared.issue] : prepared.issues;
    const normalizedRows =
      "normalizedRows" in prepared ? prepared.normalizedRows : [];
    const temporaryAssets =
      "temporaryAssets" in prepared ? prepared.temporaryAssets : [];
    const status =
      "issue" in prepared
        ? "PREFLIGHT_BLOCKED"
        : prepared.status === "PREFLIGHT_READY"
          ? "PREFLIGHT_READY"
          : "PREFLIGHT_BLOCKED";
    const sourceSpreadsheetHash =
      "sourceSpreadsheetHash" in prepared
        ? prepared.sourceSpreadsheetHash
        : createHash("sha256").update("unknown").digest("hex");
    const sourceSheetId =
      "sourceSheetId" in prepared ? prepared.sourceSheetId : input.config.sourceSheetId ?? "unknown";
    const sourceRevision =
      "sourceRevision" in prepared ? prepared.sourceRevision : 0;
    const summary =
      "summary" in prepared
        ? prepared.summary
        : {
            imageCount: 0,
            productCount: 0,
            skuCount: 0,
            totalQuantity: 0,
          };

    if (status === "PREFLIGHT_BLOCKED" && temporaryAssets.length > 0) {
      await storage.discardStagedAssets(runId).catch(() => undefined);
    }

    const persistedNormalizedRows = await roundTripJsonb(db, normalizedRows);
    const persistedSummary = await roundTripJsonb(db, summary);
    const persistedIssues = await roundTripJsonb(db, issues);
    const persistedTemporaryAssets = await roundTripJsonb(
      db,
      status === "PREFLIGHT_READY" ? temporaryAssets : [],
    );
    const sourceDigest =
      "sourceDigest" in prepared
        ? prepared.sourceDigest
        : await createCanonicalDigest(db, persistedNormalizedRows);

    const [run] = await db
      .insert(feishuCargoMigrationRuns)
      .values({
        createdByAdminUserId,
        id: runId,
        issuesJson: persistedIssues,
        normalizedRowsJson: persistedNormalizedRows,
        sourceDigest,
        sourceRevision,
        sourceSheetId,
        sourceSpreadsheetHash,
        status,
        summaryJson: persistedSummary,
        temporaryAssetsJson: persistedTemporaryAssets,
      })
      .returning({ id: feishuCargoMigrationRuns.id, status: feishuCargoMigrationRuns.status });

    return {
      runId: run.id,
      status: run.status as "PREFLIGHT_BLOCKED" | "PREFLIGHT_READY",
    };
  }

  async function confirmCargoMigration(input: {
    actor: { kind: string; userId: string };
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
    runId: string;
  }): Promise<ConfirmResult> {
    assertSuperAdmin(input.actor);
    const confirmedByAdminUserId = await findAdminMirrorIdForActor(db, input.actor.userId).catch(() => {
      throw new FeishuCargoMigrationError(
        "ACTOR_NOT_FOUND",
        "Super admin mirror profile was not found",
      );
    });

    const publishedStorageKeys: string[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${IMPORT_LOCK_TIMEOUT_MS}ms`}, true)`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${IMPORT_SINGLETON_LOCK_KEY}, 0))`,
        );

        const run = await findMigrationRunForUpdate(tx, input.runId);
        if (!run) {
          throw new FeishuCargoMigrationError(
            "MIGRATION_NOT_FOUND",
            "Feishu cargo migration run was not found",
          );
        }

        if (run.status === "IMPORTED") {
          throw new FeishuCargoMigrationError(
            "ALREADY_IMPORTED",
            "Feishu cargo migration has already been confirmed",
          );
        }
        if (run.status !== "PREFLIGHT_READY") {
          throw new FeishuCargoMigrationError(
            "MIGRATION_NOT_CONFIRMABLE",
            "Only a ready preflight can be confirmed",
          );
        }

        if (await importedMigrationExists(tx, run.id)) {
          throw new FeishuCargoMigrationError(
            "ALREADY_IMPORTED",
            "Another Feishu cargo migration has already been imported",
          );
        }
        if ((await countSkus(tx)) > 0) {
          throw new FeishuCargoMigrationError(
            "CATALOG_NOT_EMPTY",
            "Catalog SKUs already exist",
          );
        }

        let revalidated: PreparedConfirmation;
        try {
          revalidated = await revalidateRunSource({
            assetDir: options.assetDir,
            client: input.client,
            config: input.config,
            run,
          });
        } catch (error) {
          if (error instanceof FeishuCargoMigrationError && error.code === "SOURCE_STALE") {
            await tx
              .update(feishuCargoMigrationRuns)
              .set({
                status: "STALE",
                updatedAt: new Date(),
              })
              .where(eq(feishuCargoMigrationRuns.id, run.id));
          }
          throw error;
        }

        const assetBySkuCode = new Map<string, CatalogAssetRecord>();
        for (const manifest of revalidated.temporaryAssets) {
          const storageKey = await storage.commitCatalogAsset(manifest);
          publishedStorageKeys.push(storageKey);
          const asset = await ensureCatalogAssetRecord(tx, manifest, storageKey);
          assetBySkuCode.set(manifest.skuCode, asset);
        }

        const grouped = groupRowsByProduct(revalidated.normalizedRows);
        const productIdByGroup = new Map<string, string>();
        for (const [groupKey, rows] of grouped) {
          const [product] = await tx
            .insert(products)
            .values({
              description: rows[0].linkText,
              name: rows[0].productName,
            })
            .returning({ id: products.id });
          productIdByGroup.set(groupKey, product.id);
        }

        const insertedSkus = [];
        for (const row of revalidated.normalizedRows) {
          const asset = assetBySkuCode.get(row.skuCode);
          if (!asset) {
            throw new Error(`Missing staged asset for ${row.skuCode}`);
          }
          const [createdSku] = await tx
            .insert(skus)
            .values({
              color: row.color,
              combination: row.combination,
              defaultUnitPriceFen: row.defaultUnitPriceFen,
              imageAssetId: asset.id,
              imageUrl: `/api/catalog-assets/${asset.id}`,
              name: row.skuName,
              productId: productIdByGroup.get(row.productGroupKey)!,
              productUrl: row.productUrl,
              saleStatus: row.saleStatus,
              skuCode: row.skuCode,
              specification: row.specification,
              weightGrams: row.weightGrams,
            })
            .returning({ id: skus.id });
          insertedSkus.push({ row, skuId: createdSku.id });
        }

        if (insertedSkus.length > 0) {
          await tx.insert(inventoryBalances).values(
            insertedSkus.map(({ row, skuId }) => ({
              skuId,
              totalQuantity: row.totalQuantity,
            })),
          );
        }

        const movementRows = insertedSkus
          .filter(({ row }) => row.totalQuantity > 0)
          .map(({ row, skuId }) => ({
            actorId: input.actor.userId,
            actorType: "ADMIN" as const,
            afterQuantity: row.totalQuantity,
            beforeQuantity: 0,
            delta: row.totalQuantity,
            movementType: "MANUAL_INCREASE" as const,
            reason: IMPORT_REASON,
            referenceId: input.runId,
            referenceType: "FEISHU_CARGO_MIGRATION",
            skuId,
          }));
        if (movementRows.length > 0) {
          await tx.insert(inventoryMovements).values(movementRows);
        }

        await tx.insert(auditLogs).values({
          action: "FEISHU_CARGO_IMPORTED",
          actorId: input.actor.userId,
          actorType: "ADMIN",
          afterJson: {
            imageCount: revalidated.temporaryAssets.length,
            productCount: grouped.size,
            skuCount: insertedSkus.length,
          },
          beforeJson: {},
          entityId: run.id,
          entityType: "FEISHU_CARGO_MIGRATION",
          reason: IMPORT_REASON,
        });
        await enqueueCargoSyncEvent(tx, {
          idempotencyKey: `feishu-cargo-import:${run.id}`,
          reason: "feishu-cargo-import",
        });

        await tx
          .update(feishuCargoMigrationRuns)
          .set({
            confirmedByAdminUserId,
            importedAt: new Date(),
            status: "IMPORTED",
            updatedAt: new Date(),
          })
          .where(eq(feishuCargoMigrationRuns.id, run.id));

        return {
          imageCount: revalidated.temporaryAssets.length,
          productCount: grouped.size,
          skuCount: insertedSkus.length,
        };
      });

      return result;
    } catch (error) {
      if (error instanceof FeishuCargoMigrationError && error.code === "SOURCE_STALE") {
        await markRunStale(input.runId).catch(() => undefined);
      }
      await deletePublishedOrphanAssets({
        assetDir: options.assetDir,
        storageKeys: publishedStorageKeys,
      });
      throw error;
    }
  }

  return {
    confirmCargoMigration,
    createCargoPreflight,
  };
}
