import { createHash, randomUUID } from "node:crypto";

import { desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  catalogAssets,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import { inventoryReasonLabel } from "@/modules/inventory/types";

import { createCatalogAssetStorage } from "./asset-storage";
import { parseCargoSheetForSync } from "./cargo-parser";
import type {
  AppliedCargoPricePlaceholder,
  CargoPricePlaceholder,
  MigrationIssue,
  ParsedCargoSyncRow,
  TemporaryAssetManifest,
} from "./cargo-types";
import { catalogAssetExistsForDigest } from "./queries";
import {
  readFeishuSourceSnapshot,
  type FeishuSourcePort,
} from "./source-reader";

export type CatalogFieldRefreshPreview = {
  archivedSkuCount: number;
  cargoPricePlaceholders: AppliedCargoPricePlaceholder[];
  createdProductCount: number;
  createdSkuCount: number;
  degradedSkuCount: number;
  matchedSkuCount: number;
  inventoryAdjustedSkuCount: number;
  productsToMerge: number;
  skuCount: number;
  sourceSequenceCount: number;
  warningCount: number;
};

export type CatalogFieldRefreshMode =
  | "CATALOG_FIELDS_ONLY"
  | "MIGRATION_MIRROR";

export type CatalogFieldRefreshReadPort = Pick<
  FeishuSourcePort,
  | "downloadMedia"
  | "listSheets"
  | "readRangeDetails"
  | "resolveWikiSpreadsheet"
>;

type DatabaseLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type PreparedSource = {
  rows: ParsedCargoSyncRow[];
  skuCount: number;
  sourceSequenceCount: number;
  warnings: MigrationIssue[];
};

type ExistingSku = {
  id: string;
  lifecycleStatus: "ACTIVE" | "ARCHIVED";
  productId: string;
  skuCode: string;
};

type RefreshGroup = {
  canonicalProductId: string | null;
  rows: ParsedCargoSyncRow[];
};

type RefreshPlan = CatalogFieldRefreshPreview & {
  existingSkuByCode: Map<string, ExistingSku>;
  groups: RefreshGroup[];
  involvedProductIds: string[];
  systemOnlySkus: ExistingSku[];
  warnings: MigrationIssue[];
};

type CatalogFieldRefreshServiceOptions = {
  assetDir?: string;
  database?: typeof db;
};

type StagedAssets = {
  manifestBySkuCode: Map<string, TemporaryAssetManifest>;
  runId: string;
};

const SOURCE_IMAGE_DOWNLOAD_CONCURRENCY = 4;
const CATALOG_REFRESH_STARTED_ACTION =
  "CATALOG_FIELDS_REFRESH_STARTED_FROM_FEISHU";
const CATALOG_REFRESH_LOCK_NAME = "feishu-catalog-field-refresh";

function fail(code: string): never {
  throw new Error(code);
}

async function prepareSource(input: {
  cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
  client: CatalogFieldRefreshReadPort;
  expectedSkuCount?: number;
  expectedSourceSequenceCount?: number;
  sourceSheetId: string;
  sourceWikiToken: string;
}): Promise<PreparedSource> {
  // These legacy inputs remain accepted for CLI compatibility, but live sync
  // follows the current sheet instead of freezing it to the first import.
  void input.cargoPricePlaceholders;
  void input.expectedSkuCount;
  void input.expectedSourceSequenceCount;

  const snapshot = await readFeishuSourceSnapshot({
    client: input.client,
    config: {
      sourceSheetId: input.sourceSheetId,
      sourceWikiToken: input.sourceWikiToken,
    },
  });
  if ("status" in snapshot) fail(snapshot.status);

  const parsed = parseCargoSheetForSync(snapshot.values);
  if (parsed.issues.some((issue) => issue.severity === "BLOCKING")) {
    fail("PARSER_BLOCKING_ISSUES");
  }
  if (parsed.rows.length === 0) fail("NO_SYNCABLE_SKUS");

  const sourceSkuCodes = new Set(parsed.rows.map((row) => row.skuCode));
  if (sourceSkuCodes.size !== parsed.rows.length) fail("PARSER_BLOCKING_ISSUES");

  return {
    rows: parsed.rows,
    skuCount: sourceSkuCodes.size,
    sourceSequenceCount: new Set(
      parsed.rows.flatMap((row) =>
        row.sourceSequence === null ? [] : [row.sourceSequence],
      ),
    ).size,
    warnings: parsed.warnings,
  };
}

async function buildRefreshPlan(
  database: DatabaseLike,
  source: PreparedSource,
): Promise<RefreshPlan> {
  const [existingSkus, existingProducts] = await Promise.all([
    database
      .select({
        id: skus.id,
        lifecycleStatus: skus.lifecycleStatus,
        productId: skus.productId,
        skuCode: skus.skuCode,
      })
      .from(skus),
    database
      .select({ id: products.id, sourceSequence: products.sourceSequence })
      .from(products),
  ]);
  const existingSkuByCode = new Map(
    existingSkus.map((row) => [row.skuCode, row]),
  );
  const productIdBySourceSequence = new Map(
    existingProducts.flatMap((row) =>
      row.sourceSequence === null ? [] : [[row.sourceSequence, row.id] as const],
    ),
  );
  const rowsByGroup = new Map<string, ParsedCargoSyncRow[]>();
  for (const row of source.rows) {
    const group = rowsByGroup.get(row.productGroupKey) ?? [];
    group.push(row);
    rowsByGroup.set(row.productGroupKey, group);
  }

  const groups: RefreshGroup[] = [];
  const involvedProductIds = new Set<string>();
  const selectedCanonicalProductIds = new Set<string>();
  let createdProductCount = 0;
  let productsToMerge = 0;
  for (const rows of rowsByGroup.values()) {
    const skuCountByProductId = new Map<string, number>();
    for (const row of rows) {
      const productId = existingSkuByCode.get(row.skuCode)?.productId;
      if (!productId) continue;
      skuCountByProductId.set(productId, (skuCountByProductId.get(productId) ?? 0) + 1);
      involvedProductIds.add(productId);
    }
    const candidates = [...skuCountByProductId.entries()].sort(
      ([leftId, leftCount], [rightId, rightCount]) =>
        rightCount - leftCount || leftId.localeCompare(rightId),
    );
    let canonicalProductId: string | null = candidates[0]?.[0] ?? null;
    if (canonicalProductId === null) {
      const sourceSequence = rows[0]?.sourceSequence;
      canonicalProductId = sourceSequence
        ? (productIdBySourceSequence.get(sourceSequence) ?? null)
        : null;
      if (canonicalProductId) involvedProductIds.add(canonicalProductId);
    }
    if (canonicalProductId) {
      if (selectedCanonicalProductIds.has(canonicalProductId)) {
        fail("PRODUCT_GROUPING_CONFLICT");
      }
      selectedCanonicalProductIds.add(canonicalProductId);
    } else {
      createdProductCount += 1;
    }
    productsToMerge += Math.max(0, candidates.length - 1);
    groups.push({ canonicalProductId, rows });
  }

  const matchedSkuCount = source.rows.filter((row) =>
    existingSkuByCode.has(row.skuCode),
  ).length;
  const sourceSkuCodes = new Set(source.rows.map((row) => row.skuCode));
  return {
    archivedSkuCount: 0,
    cargoPricePlaceholders: [],
    createdProductCount,
    createdSkuCount: source.skuCount - matchedSkuCount,
    degradedSkuCount: source.rows.filter((row) => row.degradedReasons.length > 0)
      .length,
    existingSkuByCode,
    groups,
    involvedProductIds: [...involvedProductIds],
    inventoryAdjustedSkuCount: 0,
    matchedSkuCount,
    productsToMerge,
    skuCount: source.skuCount,
    sourceSequenceCount: source.sourceSequenceCount,
    systemOnlySkus: existingSkus.filter(
      (row) => !sourceSkuCodes.has(row.skuCode),
    ),
    warningCount: source.warnings.length,
    warnings: source.warnings,
  };
}

async function stageSourceAssets(input: {
  assetDir?: string;
  client: CatalogFieldRefreshReadPort;
  rows: readonly ParsedCargoSyncRow[];
}): Promise<StagedAssets> {
  const runId = randomUUID();
  const storage = createCatalogAssetStorage({ assetDir: input.assetDir });
  const manifestBySkuCode = new Map<string, TemporaryAssetManifest>();
  const manifestByDownloadedDigest = new Map<
    string,
    Promise<TemporaryAssetManifest>
  >();
  const rowsByFileToken = new Map<string, ParsedCargoSyncRow[]>();
  for (const row of input.rows) {
    if (row.imageFileToken === null) continue;
    const rows = rowsByFileToken.get(row.imageFileToken) ?? [];
    rows.push(row);
    rowsByFileToken.set(row.imageFileToken, rows);
  }
  const entries = [...rowsByFileToken.entries()];
  let cursor = 0;
  let firstError: unknown;

  try {
    const downloadWorker = async () => {
      while (firstError === undefined) {
        const entry = entries[cursor];
        cursor += 1;
        if (!entry) return;
        const [fileToken, rows] = entry;
        try {
          const media = await input.client.downloadMedia(fileToken);
          const downloadedDigest = createHash("sha256")
            .update(media.bytes)
            .digest("hex");
          let manifestPromise = manifestByDownloadedDigest.get(downloadedDigest);
          if (!manifestPromise) {
            const representative = rows[0]!;
            manifestPromise = storage.stageCatalogAsset({
              bytes: media.bytes,
              contentType: media.contentType,
              originalFileName: media.fileName ?? `${representative.skuCode}.bin`,
              runId,
              skuCode: representative.skuCode,
            });
            manifestByDownloadedDigest.set(downloadedDigest, manifestPromise);
          }
          const manifest = await manifestPromise;
          for (const row of rows) {
            manifestBySkuCode.set(row.skuCode, {
              ...manifest,
              skuCode: row.skuCode,
            });
          }
        } catch (error) {
          firstError ??= error;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SOURCE_IMAGE_DOWNLOAD_CONCURRENCY, entries.length) },
        downloadWorker,
      ),
    );
    if (firstError !== undefined) throw firstError;
    return { manifestBySkuCode, runId };
  } catch {
    await storage.discardStagedAssets(runId).catch(() => undefined);
    fail("SOURCE_IMAGE_DOWNLOAD_FAILED");
  }
}

function preparedSourceDigest(source: PreparedSource) {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

async function lockCatalogRefresh(database: DbTransaction) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext(${CATALOG_REFRESH_LOCK_NAME}))`,
  );
}

async function lockAndAssertMigrationMirrorInventory(
  database: DbTransaction,
) {
  await database.execute(sql`
    select sku_id
    from inventory_balances
    order by sku_id
    for update
  `);
  const [activeReservation] = await database
    .select({ id: inventoryReservations.id })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.status, "ACTIVE"))
    .limit(1);
  if (activeReservation) fail("MIRROR_ACTIVE_RESERVATIONS");
}

async function registerRefreshAttempt(input: {
  actorUserId: string;
  database: typeof db;
  reason: string;
  runId: string;
}) {
  await input.database.transaction(async (transaction) => {
    await lockCatalogRefresh(transaction);
    await transaction.insert(auditLogs).values({
      action: CATALOG_REFRESH_STARTED_ACTION,
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {},
      beforeJson: {},
      entityId: input.runId,
      entityType: "CATALOG",
      reason: input.reason,
    });
  });
}

async function assertLatestRefreshAttempt(
  database: DbTransaction,
  runId: string,
) {
  const [latest] = await database
    .select({ entityId: auditLogs.entityId })
    .from(auditLogs)
    .where(eq(auditLogs.action, CATALOG_REFRESH_STARTED_ACTION))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  if (latest?.entityId !== runId) fail("SOURCE_SYNC_SUPERSEDED");
}

async function publishSourceAssets(input: {
  assetDir?: string;
  database: DbTransaction;
  staged: StagedAssets;
}) {
  const storage = createCatalogAssetStorage({ assetDir: input.assetDir });
  const assetByDigest = new Map<string, { id: string; storageKey: string }>();
  for (const manifest of input.staged.manifestBySkuCode.values()) {
    if (assetByDigest.has(manifest.contentSha256)) continue;
    const existing = await catalogAssetExistsForDigest(
      input.database,
      manifest.contentSha256,
    );
    if (existing) {
      assetByDigest.set(manifest.contentSha256, existing);
      continue;
    }
    const storageKey = await storage.commitCatalogAsset(manifest);
    const [created] = await input.database
      .insert(catalogAssets)
      .values({
        byteSize: manifest.byteSize,
        contentSha256: manifest.contentSha256,
        mimeType: manifest.mimeType,
        originalFileName: manifest.originalFileName,
        storageKey,
      })
      .onConflictDoNothing({ target: catalogAssets.contentSha256 })
      .returning({ id: catalogAssets.id, storageKey: catalogAssets.storageKey });
    if (created) {
      assetByDigest.set(manifest.contentSha256, created);
      continue;
    }
    const concurrent = await catalogAssetExistsForDigest(
      input.database,
      manifest.contentSha256,
    );
    if (!concurrent) fail("CATALOG_ASSET_PUBLISH_FAILED");
    assetByDigest.set(manifest.contentSha256, concurrent);
  }

  return new Map(
    [...input.staged.manifestBySkuCode].map(([skuCode, manifest]) => {
      const asset = assetByDigest.get(manifest.contentSha256);
      if (!asset) fail("CATALOG_ASSET_PUBLISH_FAILED");
      return [skuCode, asset] as const;
    }),
  );
}

async function applyPlan(input: {
  actorUserId: string;
  assetBySkuCode: Map<string, { id: string; storageKey: string }>;
  database: DbTransaction;
  mode: CatalogFieldRefreshMode;
  plan: RefreshPlan;
  reason: string;
  runId: string;
}): Promise<{ archivedSkuCount: number; inventoryAdjustedSkuCount: number }> {
  const now = new Date();
  if (input.plan.involvedProductIds.length > 0) {
    await input.database
      .update(products)
      .set({ sourceSequence: null, updatedAt: now })
      .where(inArray(products.id, input.plan.involvedProductIds));
  }

  const sourceSkuTargets: Array<{
    isNew: boolean;
    row: ParsedCargoSyncRow;
    skuId: string;
  }> = [];
  for (const group of input.plan.groups) {
    const parent = group.rows[0]!;
    let productId = group.canonicalProductId;
    if (!productId) {
      const productInsert = input.database
        .insert(products)
        .values({
          linkText: parent.linkText,
          name: parent.productName,
          sourceSequence: parent.sourceSequence,
        });
      const [createdProduct] = parent.sourceSequence === null
        ? await productInsert.returning({ id: products.id })
        : await productInsert
            .onConflictDoNothing()
            .returning({ id: products.id });
      if (createdProduct) {
        productId = createdProduct.id;
      } else if (parent.sourceSequence !== null) {
        const [concurrentProduct] = await input.database
          .select({ id: products.id })
          .from(products)
          .where(eq(products.sourceSequence, parent.sourceSequence))
          .limit(1);
        if (!concurrentProduct) fail("CATALOG_PRODUCT_CONCURRENT_WRITE_FAILED");
        productId = concurrentProduct.id;
      }
      if (!productId) fail("CATALOG_PRODUCT_CREATE_FAILED");
    }
    await input.database
      .update(products)
      .set({
        linkText: parent.linkText,
        name: parent.productName,
        sourceSequence: parent.sourceSequence,
        ...(input.mode === "MIGRATION_MIRROR" ? { status: "ACTIVE" as const } : {}),
        updatedAt: now,
      })
      .where(eq(products.id, productId));

    for (const row of group.rows) {
      const asset = input.assetBySkuCode.get(row.skuCode) ?? null;
      const existingSku = input.plan.existingSkuByCode.get(row.skuCode);
      const metadataFor = (lifecycleStatus?: "ACTIVE" | "ARCHIVED") => ({
        ...(input.mode === "MIGRATION_MIRROR"
          ? {
              archiveReason: null,
              archivedAt: null,
              archivedByAdminUserId: null,
              lifecycleStatus: "ACTIVE" as const,
            }
          : {}),
        cargoUnitPriceMilliYuan: row.cargoUnitPriceMilliYuan,
        color: row.color,
        combination: row.combination,
        defaultUnitPriceFen: row.defaultUnitPriceFen,
        defaultUnitPriceMilliYuan: row.defaultUnitPriceMilliYuan,
        imageAssetId: asset?.id ?? null,
        imageUrl: asset ? `/api/catalog-assets/${asset.id}` : null,
        name: row.skuName,
        productId,
        productUrl: row.productUrl,
        saleStatus:
          input.mode !== "MIGRATION_MIRROR" && lifecycleStatus === "ARCHIVED"
            ? ("NOT_SELLABLE" as const)
            : row.saleStatus,
        specification: row.specification,
        updatedAt: now,
        weightGrams: row.weightGrams,
      });
      if (existingSku) {
        await input.database
          .update(skus)
          .set(metadataFor(existingSku.lifecycleStatus))
          .where(eq(skus.id, existingSku.id));
        sourceSkuTargets.push({
          isNew: false,
          row,
          skuId: existingSku.id,
        });
      } else {
        const [createdSku] = await input.database
          .insert(skus)
          .values({ ...metadataFor(), skuCode: row.skuCode })
          .onConflictDoNothing({ target: skus.skuCode })
          .returning({ id: skus.id });
        if (createdSku) {
          sourceSkuTargets.push({ isNew: true, row, skuId: createdSku.id });
          continue;
        }
        const [concurrentSku] = await input.database
          .select({ id: skus.id, lifecycleStatus: skus.lifecycleStatus })
          .from(skus)
          .where(eq(skus.skuCode, row.skuCode))
          .limit(1);
        if (!concurrentSku) fail("CATALOG_SKU_CONCURRENT_WRITE_FAILED");
        await input.database
          .update(skus)
          .set(metadataFor(concurrentSku.lifecycleStatus))
          .where(eq(skus.id, concurrentSku.id));
        sourceSkuTargets.push({
          isNew: false,
          row,
          skuId: concurrentSku.id,
        });
      }
    }
  }

  const insertedSkus = sourceSkuTargets.filter((target) => target.isNew);
  let archivedSkuCount = 0;
  let inventoryAdjustedSkuCount = 0;
  if (input.mode === "MIGRATION_MIRROR") {
    const newlyArchivedIds = input.plan.systemOnlySkus
      .filter((row) => row.lifecycleStatus === "ACTIVE")
      .map((row) => row.id);
    archivedSkuCount = newlyArchivedIds.length;
    if (newlyArchivedIds.length > 0) {
      await input.database
        .update(skus)
        .set({
          archiveReason: "迁移期飞书货盘中已缺失",
          archivedAt: now,
          archivedByAdminUserId: input.actorUserId,
          lifecycleStatus: "ARCHIVED",
          saleStatus: "NOT_SELLABLE",
          updatedAt: now,
        })
        .where(inArray(skus.id, newlyArchivedIds));
    }

    const mirrorTargets = [
      ...sourceSkuTargets.map(({ isNew, row, skuId }) => ({
        isNew,
        skuId,
        targetQuantity: row.totalQuantity ?? 0,
      })),
      ...input.plan.systemOnlySkus.map((row) => ({
        isNew: false,
        skuId: row.id,
        targetQuantity: 0,
      })),
    ];
    const balanceRows = mirrorTargets.length > 0
      ? await input.database
          .select({
            skuId: inventoryBalances.skuId,
            totalQuantity: inventoryBalances.totalQuantity,
          })
          .from(inventoryBalances)
          .where(inArray(
            inventoryBalances.skuId,
            mirrorTargets.map((target) => target.skuId),
          ))
      : [];
    const balanceBySkuId = new Map(
      balanceRows.map((row) => [row.skuId, row.totalQuantity]),
    );
    const missingBalances = mirrorTargets.filter(
      (target) => !balanceBySkuId.has(target.skuId),
    );
    if (missingBalances.length > 0) {
      await input.database.insert(inventoryBalances).values(
        missingBalances.map((target) => ({
          skuId: target.skuId,
          totalQuantity: target.targetQuantity,
        })),
      );
    }

    const movementRows = [];
    for (const target of mirrorTargets) {
      const beforeQuantity = balanceBySkuId.get(target.skuId) ?? 0;
      const delta = target.targetQuantity - beforeQuantity;
      if (delta === 0) continue;
      inventoryAdjustedSkuCount += 1;
      if (balanceBySkuId.has(target.skuId)) {
        await input.database
          .update(inventoryBalances)
          .set({ totalQuantity: target.targetQuantity, updatedAt: now })
          .where(eq(inventoryBalances.skuId, target.skuId));
      }
      const reasonCode = target.isNew
        ? ("FEISHU_INITIAL_IMPORT" as const)
        : ("STOCKTAKE_CORRECTION" as const);
      movementRows.push({
        actorId: input.actorUserId,
        actorType: "ADMIN" as const,
        afterQuantity: target.targetQuantity,
        beforeQuantity,
        delta,
        movementType:
          delta > 0 ? ("MANUAL_INCREASE" as const) : ("MANUAL_DECREASE" as const),
        reason: inventoryReasonLabel(reasonCode),
        reasonCode,
        referenceId: input.runId,
        referenceType: "FEISHU_CATALOG_MIRROR",
        skuId: target.skuId,
      });
    }
    if (movementRows.length > 0) {
      await input.database.insert(inventoryMovements).values(movementRows);
    }
  } else if (insertedSkus.length > 0) {
    await input.database.insert(inventoryBalances).values(
      insertedSkus.map(({ row, skuId }) => ({
        skuId,
        totalQuantity: row.totalQuantity ?? 0,
      })),
    );
    const movementRows = insertedSkus
      .filter(({ row }) => (row.totalQuantity ?? 0) > 0)
      .map(({ row, skuId }) => ({
        actorId: input.actorUserId,
        actorType: "ADMIN" as const,
        afterQuantity: row.totalQuantity!,
        beforeQuantity: 0,
        delta: row.totalQuantity!,
        movementType: "MANUAL_INCREASE" as const,
        reason: inventoryReasonLabel("FEISHU_INITIAL_IMPORT"),
        reasonCode: "FEISHU_INITIAL_IMPORT" as const,
        referenceId: input.runId,
        referenceType: "FEISHU_CATALOG_SYNC",
        skuId,
      }));
    if (movementRows.length > 0) {
      await input.database.insert(inventoryMovements).values(movementRows);
    }
  }

  await input.database.insert(auditLogs).values({
    action: "CATALOG_FIELDS_REFRESHED_FROM_FEISHU",
    actorId: input.actorUserId,
    actorType: "ADMIN",
    afterJson: {
      archivedSkuCount,
      createdProductCount: input.plan.createdProductCount,
      createdSkuCount: input.plan.createdSkuCount,
      degradedSkuCount: input.plan.degradedSkuCount,
      inventoryAdjustedSkuCount,
      matchedSkuCount: input.plan.matchedSkuCount,
      mode: input.mode,
      productsToMerge: input.plan.productsToMerge,
      skuCount: input.plan.skuCount,
      sourceSequenceCount: input.plan.sourceSequenceCount,
      warningCount: input.plan.warningCount,
      warnings: input.plan.warnings.map((warning) => ({
        code: warning.code,
        sourceRowNumber: warning.sourceRowNumber,
      })),
    },
    beforeJson: {},
    entityId: input.runId,
    entityType: "CATALOG",
    reason: input.reason,
  });
  return { archivedSkuCount, inventoryAdjustedSkuCount };
}

function previewForPlan(
  plan: RefreshPlan,
  applied: { archivedSkuCount: number; inventoryAdjustedSkuCount: number } = {
    archivedSkuCount: 0,
    inventoryAdjustedSkuCount: 0,
  },
): CatalogFieldRefreshPreview {
  return {
    archivedSkuCount: applied.archivedSkuCount,
    cargoPricePlaceholders: [],
    createdProductCount: plan.createdProductCount,
    createdSkuCount: plan.createdSkuCount,
    degradedSkuCount: plan.degradedSkuCount,
    inventoryAdjustedSkuCount: applied.inventoryAdjustedSkuCount,
    matchedSkuCount: plan.matchedSkuCount,
    productsToMerge: plan.productsToMerge,
    skuCount: plan.skuCount,
    sourceSequenceCount: plan.sourceSequenceCount,
    warningCount: plan.warningCount,
  };
}

export function createCatalogFieldRefreshService(
  options: CatalogFieldRefreshServiceOptions | typeof db = {},
) {
  const isDatabase = "transaction" in options;
  const database = isDatabase ? options : (options.database ?? db);
  const assetDir = isDatabase ? undefined : options.assetDir;

  return {
    async preview(input: {
      cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
      client: CatalogFieldRefreshReadPort;
      mode?: CatalogFieldRefreshMode;
      sourceSheetId: string;
      sourceWikiToken: string;
      expectedSourceSequenceCount?: number;
      expectedSkuCount?: number;
    }): Promise<CatalogFieldRefreshPreview> {
      const source = await prepareSource(input);
      return previewForPlan(await buildRefreshPlan(database, source));
    },
    async apply(input: {
      actorUserId: string;
      cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
      client: CatalogFieldRefreshReadPort;
      mode?: CatalogFieldRefreshMode;
      reason: string;
      sourceSheetId: string;
      sourceWikiToken: string;
      expectedSourceSequenceCount?: number;
      expectedSkuCount?: number;
    }): Promise<CatalogFieldRefreshPreview> {
      const reason = input.reason.trim();
      if (!reason) fail("OPERATOR_REASON_REQUIRED");

      const runId = randomUUID();
      const mode = input.mode ?? "CATALOG_FIELDS_ONLY";
      await registerRefreshAttempt({
        actorUserId: input.actorUserId,
        database,
        reason,
        runId,
      });
      const source = await prepareSource(input);
      const staged = await stageSourceAssets({
        assetDir,
        client: input.client,
        rows: source.rows,
      });
      const storage = createCatalogAssetStorage({ assetDir });
      try {
        const verifiedSource = await prepareSource(input);
        if (preparedSourceDigest(verifiedSource) !== preparedSourceDigest(source)) {
          fail("SOURCE_CHANGED_DURING_SYNC");
        }
        return await database.transaction(async (transaction) => {
          await lockCatalogRefresh(transaction);
          await assertLatestRefreshAttempt(transaction, runId);
          const plan = await buildRefreshPlan(transaction, verifiedSource);
          if (mode === "MIGRATION_MIRROR") {
            await lockAndAssertMigrationMirrorInventory(transaction);
          }
          const assetBySkuCode = await publishSourceAssets({
            assetDir,
            database: transaction,
            staged,
          });
          const applied = await applyPlan({
            actorUserId: input.actorUserId,
            assetBySkuCode,
            database: transaction,
            mode,
            plan,
            reason,
            runId,
          });
          return previewForPlan(plan, applied);
        });
      } finally {
        await storage.discardStagedAssets(staged.runId).catch(() => undefined);
      }
    },
  };
}
