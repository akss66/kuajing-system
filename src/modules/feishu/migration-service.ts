import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

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
import type { SuperAdminPrincipal } from "@/modules/identity/principal";

import { createCatalogAssetStorage } from "./asset-storage";
import { parseLegacyCargoSheet } from "./cargo-parser";
import type {
  MigrationIssue,
  MigrationSummary,
  NormalizedCargoRow,
  ParsedCargoRow,
  TemporaryAssetManifest,
} from "./cargo-types";
import {
  catalogAssetExistsForDigest,
  findActiveSuperAdminMirrorId,
  findMigrationRun,
  findMigrationRunForUpdate,
  findProductBySourceSequence,
  findSkuByCode,
  findSkuCodesByProductId,
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

type ConfirmResult = MigrationSummary;

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
  sourceRevision: number;
  sourceSheetId: string;
  sourceSpreadsheetHash: string;
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
      summary: MigrationSummary;
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
      | "ROLLOUT_READ_ONLY"
      | "SOURCE_STALE",
    message: string,
  ) {
    super(message);
    this.name = "FeishuCargoMigrationError";
  }
}

function assertSuperAdminPrincipal(
  actor: { kind: string; userId: string },
): asserts actor is SuperAdminPrincipal {
  if (actor.kind !== "SUPER_ADMIN") {
    throw new FeishuCargoMigrationError(
      "FORBIDDEN_SUPER_ADMIN",
      "Only the super admin can run the Feishu cargo migration",
    );
  }
}

async function resolveSuperAdminMirrorId(
  actor: { kind: string; userId: string },
) {
  assertSuperAdminPrincipal(actor);

  return await findActiveSuperAdminMirrorId(db, actor.userId).catch((error: Error) => {
    if (error.message === "Super admin actor is not authorized") {
      throw new FeishuCargoMigrationError(
        "FORBIDDEN_SUPER_ADMIN",
        "Only the super admin can run the Feishu cargo migration",
      );
    }

    throw new FeishuCargoMigrationError(
      "ACTOR_NOT_FOUND",
      "Super admin mirror profile was not found",
    );
  });
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
    cargoUnitPriceMilliYuan: row.cargoUnitPriceMilliYuan,
    combination: row.combination,
    defaultUnitPriceFen: row.defaultUnitPriceFen,
    defaultUnitPriceMilliYuan: row.defaultUnitPriceMilliYuan,
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
    sourceSequence: row.sourceSequence,
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
  if (
    sourceSnapshot.selectedSheet.sheetId !== input.run.sourceSheetId ||
    sourceSnapshot.spreadsheetTokenHash !== input.run.sourceSpreadsheetHash
  ) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source location changed after preflight",
    );
  }
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

  const reparsedNormalizedRows: NormalizedCargoRow[] = [];
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
    reparsedNormalizedRows.push(normalizedRow);

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

  const reparsedDigest = await createCanonicalDigest(db, reparsedNormalizedRows);
  if (reparsedDigest !== input.run.sourceDigest) {
    throw new FeishuCargoMigrationError(
      "SOURCE_STALE",
      "Feishu source content changed after preflight",
    );
  }

  return {
    normalizedRows: reparsedNormalizedRows,
    sourceDigest: reparsedDigest,
    sourceRevision: sourceSnapshot.revision,
    sourceSheetId: sourceSnapshot.selectedSheet.sheetId,
    sourceSpreadsheetHash: sourceSnapshot.spreadsheetTokenHash,
    temporaryAssets: replacementTemporaryAssets,
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

function groupRowsBySourceSequence(rows: NormalizedCargoRow[]) {
  const grouped = new Map<string, NormalizedCargoRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.sourceSequence) ?? [];
    group.push(row);
    grouped.set(row.sourceSequence, group);
  }
  return grouped;
}

function summaryForRun(run: ExistingMigrationRun): MigrationSummary {
  const summary = run.summaryJson as Omit<MigrationSummary, "sourceSequenceCount"> &
    Partial<Pick<MigrationSummary, "sourceSequenceCount">>;
  return {
    ...summary,
    sourceSequenceCount: summary.sourceSequenceCount ?? summary.productCount,
  };
}

export function createFeishuCargoMigrationService(options: MigrationServiceOptions = {}) {
  const storage = createCatalogAssetStorage({ assetDir: options.assetDir });

  async function createCargoPreflight(input: {
    actor: SuperAdminPrincipal;
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken"> & {
      sourceSheetId: string;
    };
  }): Promise<PreflightReadyResult>;
  async function createCargoPreflight(input: {
    actor: SuperAdminPrincipal;
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  }): Promise<FeishuSourceSelectionRequired | PreflightReadyResult>;
  async function createCargoPreflight(input: {
    actor: SuperAdminPrincipal;
    client: FeishuSourcePort;
    config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
  }): Promise<FeishuSourceSelectionRequired | PreflightReadyResult> {
    const createdByAdminUserId = await resolveSuperAdminMirrorId(input.actor);
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
            sourceSequenceCount: 0,
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
    actor: SuperAdminPrincipal;
    client: FeishuSourcePort;
    config: Pick<
      FeishuIntegrationConfig,
      | "cargoImportEnabled"
      | "cargoWritesEnabled"
      | "sourceSheetId"
      | "sourceWikiToken"
    >;
    runId: string;
  }): Promise<ConfirmResult> {
    const confirmedByAdminUserId = await resolveSuperAdminMirrorId(input.actor);
    try {
      const currentRun = await findMigrationRun(db, input.runId);
      if (!currentRun) {
        throw new FeishuCargoMigrationError(
          "MIGRATION_NOT_FOUND",
          "Feishu cargo migration run was not found",
        );
      }
      if (currentRun.status === "IMPORTED") {
        return summaryForRun(currentRun);
      }
      if (input.config.cargoImportEnabled !== true) {
        throw new FeishuCargoMigrationError(
          "ROLLOUT_READ_ONLY",
          "Feishu cargo database import stays disabled until FEISHU_CARGO_IMPORT_ENABLED=true",
        );
      }
      if (currentRun.status !== "PREFLIGHT_READY") {
        throw new FeishuCargoMigrationError(
          "MIGRATION_NOT_CONFIRMABLE",
          "Only a ready preflight can be confirmed",
        );
      }

      let revalidated: PreparedConfirmation;
      try {
        revalidated = await revalidateRunSource({
          assetDir: options.assetDir,
          client: input.client,
          config: {
            ...input.config,
            sourceSheetId: currentRun.sourceSheetId,
          },
          run: currentRun,
        });
      } catch (error) {
        if (error instanceof FeishuCargoMigrationError && error.code === "SOURCE_STALE") {
          await markRunStale(input.runId).catch(() => undefined);
        }
        throw error;
      }

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
          return summaryForRun(run);
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
        const lockedRunDigest = await createCanonicalDigest(
          tx,
          run.normalizedRowsJson as NormalizedCargoRow[],
        );
        if (
          run.sourceDigest !== revalidated.sourceDigest ||
          lockedRunDigest !== revalidated.sourceDigest ||
          run.sourceRevision !== revalidated.sourceRevision ||
          run.sourceSheetId !== revalidated.sourceSheetId ||
          run.sourceSpreadsheetHash !== revalidated.sourceSpreadsheetHash
        ) {
          throw new FeishuCargoMigrationError(
            "SOURCE_STALE",
            "Feishu source content no longer matches the approved preflight",
          );
        }

        const assetBySkuCode = new Map<string, CatalogAssetRecord>();
        const assetByContentDigest = new Map<string, CatalogAssetRecord>();
        for (const manifest of revalidated.temporaryAssets) {
          const sharedAsset = assetByContentDigest.get(manifest.contentSha256);
          if (sharedAsset) {
            assetBySkuCode.set(manifest.skuCode, sharedAsset);
            continue;
          }

          const storageKey = await storage.commitCatalogAsset(manifest);
          const asset = await ensureCatalogAssetRecord(tx, manifest, storageKey);
          assetByContentDigest.set(manifest.contentSha256, asset);
          assetBySkuCode.set(manifest.skuCode, asset);
        }

        const grouped = groupRowsBySourceSequence(revalidated.normalizedRows);
        const productIdByGroup = new Map<string, string>();
        const claimedProductIds = new Set<string>();
        for (const [sourceSequence, rows] of grouped) {
          const importedSkuCodes = new Set(rows.map((row) => row.skuCode));
          let product = await findProductBySourceSequence(tx, sourceSequence);
          if (!product) {
            for (const row of rows) {
              const existingSku = await findSkuByCode(tx, row.skuCode);
              if (
                existingSku &&
                existingSku.productSourceSequence == null &&
                !claimedProductIds.has(existingSku.productId)
              ) {
                const siblingSkus = await findSkuCodesByProductId(
                  tx,
                  existingSku.productId,
                );
                if (siblingSkus.every((sku) => importedSkuCodes.has(sku.skuCode))) {
                  product = { id: existingSku.productId };
                  break;
                }
              }
            }
          }

          if (product) {
            await tx
              .update(products)
              .set({
                cargoUnitPriceMilliYuan: rows[0].cargoUnitPriceMilliYuan,
                linkText: rows[0].linkText,
                name: rows[0].productName,
                sourceSequence,
                updatedAt: new Date(),
              })
              .where(eq(products.id, product.id));
          } else {
            [product] = await tx
              .insert(products)
              .values({
                cargoUnitPriceMilliYuan: rows[0].cargoUnitPriceMilliYuan,
                linkText: rows[0].linkText,
                name: rows[0].productName,
                sourceSequence,
              })
              .returning({ id: products.id });
          }
          claimedProductIds.add(product.id);
          productIdByGroup.set(sourceSequence, product.id);
        }

        const insertedSkus = [];
        for (const row of revalidated.normalizedRows) {
          const asset = assetBySkuCode.get(row.skuCode);
          if (!asset) {
            throw new Error(`Missing staged asset for ${row.skuCode}`);
          }
          const productId = productIdByGroup.get(row.sourceSequence)!;
          const skuMetadata = {
            color: row.color,
            combination: row.combination,
            defaultUnitPriceFen: row.defaultUnitPriceFen,
            defaultUnitPriceMilliYuan: row.defaultUnitPriceMilliYuan,
            imageAssetId: asset.id,
            imageUrl: `/api/catalog-assets/${asset.id}`,
            name: row.skuName,
            productId,
            productUrl: row.productUrl,
            saleStatus: row.saleStatus,
            specification: row.specification,
            weightGrams: row.weightGrams,
          };
          const existingSku = await findSkuByCode(tx, row.skuCode);
          if (existingSku) {
            await tx
              .update(skus)
              .set({ ...skuMetadata, updatedAt: new Date() })
              .where(eq(skus.id, existingSku.id));
          } else {
            const [createdSku] = await tx
              .insert(skus)
              .values({ ...skuMetadata, skuCode: row.skuCode })
              .returning({ id: skus.id });
            insertedSkus.push({ row, skuId: createdSku.id });
          }
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
            skuCount: revalidated.normalizedRows.length,
            sourceSequenceCount: grouped.size,
          },
          beforeJson: {},
          entityId: run.id,
          entityType: "FEISHU_CARGO_MIGRATION",
          reason: IMPORT_REASON,
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

        return summaryForRun(run);
      });

      return result;
    } catch (error) {
      if (error instanceof FeishuCargoMigrationError && error.code === "SOURCE_STALE") {
        await markRunStale(input.runId).catch(() => undefined);
      }
      throw error;
    } finally {
      await storage.discardStagedAssets(input.runId).catch(() => undefined);
    }
  }

  return {
    confirmCargoMigration,
    createCargoPreflight,
  };
}
