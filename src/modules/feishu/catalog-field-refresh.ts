import { createHash, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  catalogAssets,
  inventoryBalances,
  inventoryMovements,
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
  cargoPricePlaceholders: AppliedCargoPricePlaceholder[];
  createdProductCount: number;
  createdSkuCount: number;
  degradedSkuCount: number;
  matchedSkuCount: number;
  productsToMerge: number;
  skuCount: number;
  sourceSequenceCount: number;
  warningCount: number;
};

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
  return {
    cargoPricePlaceholders: [],
    createdProductCount,
    createdSkuCount: source.skuCount - matchedSkuCount,
    degradedSkuCount: source.rows.filter((row) => row.degradedReasons.length > 0)
      .length,
    existingSkuByCode,
    groups,
    involvedProductIds: [...involvedProductIds],
    matchedSkuCount,
    productsToMerge,
    skuCount: source.skuCount,
    sourceSequenceCount: source.sourceSequenceCount,
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
  const manifestByDownloadedDigest = new Map<string, TemporaryAssetManifest>();

  try {
    for (const row of input.rows) {
      if (row.imageFileToken === null) continue;
      const media = await input.client.downloadMedia(row.imageFileToken);
      const downloadedDigest = createHash("sha256").update(media.bytes).digest("hex");
      const sharedManifest = manifestByDownloadedDigest.get(downloadedDigest);
      if (sharedManifest) {
        manifestBySkuCode.set(row.skuCode, {
          ...sharedManifest,
          skuCode: row.skuCode,
        });
        continue;
      }
      const manifest = await storage.stageCatalogAsset({
        bytes: media.bytes,
        contentType: media.contentType,
        originalFileName: media.fileName ?? `${row.skuCode}.bin`,
        runId,
        skuCode: row.skuCode,
      });
      manifestByDownloadedDigest.set(downloadedDigest, manifest);
      manifestBySkuCode.set(row.skuCode, manifest);
    }
    return { manifestBySkuCode, runId };
  } catch {
    await storage.discardStagedAssets(runId).catch(() => undefined);
    fail("SOURCE_IMAGE_DOWNLOAD_FAILED");
  }
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
  plan: RefreshPlan;
  reason: string;
  runId: string;
}) {
  const now = new Date();
  if (input.plan.involvedProductIds.length > 0) {
    await input.database
      .update(products)
      .set({ sourceSequence: null, updatedAt: now })
      .where(inArray(products.id, input.plan.involvedProductIds));
  }

  const insertedSkus: Array<{ row: ParsedCargoSyncRow; skuId: string }> = [];
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
        updatedAt: now,
      })
      .where(eq(products.id, productId));

    for (const row of group.rows) {
      const asset = input.assetBySkuCode.get(row.skuCode) ?? null;
      const existingSku = input.plan.existingSkuByCode.get(row.skuCode);
      const metadataFor = (lifecycleStatus?: "ACTIVE" | "ARCHIVED") => ({
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
          lifecycleStatus === "ARCHIVED" ? "NOT_SELLABLE" : row.saleStatus,
        specification: row.specification,
        updatedAt: now,
        weightGrams: row.weightGrams,
      });
      if (existingSku) {
        await input.database
          .update(skus)
          .set(metadataFor(existingSku.lifecycleStatus))
          .where(eq(skus.id, existingSku.id));
      } else {
        const [createdSku] = await input.database
          .insert(skus)
          .values({ ...metadataFor(), skuCode: row.skuCode })
          .onConflictDoNothing({ target: skus.skuCode })
          .returning({ id: skus.id });
        if (createdSku) {
          insertedSkus.push({ row, skuId: createdSku.id });
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
      }
    }
  }

  if (insertedSkus.length > 0) {
    await input.database.insert(inventoryBalances).values(
      insertedSkus.map(({ row, skuId }) => ({
        skuId,
        totalQuantity: row.totalQuantity ?? 0,
      })),
    );
  }
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

  await input.database.insert(auditLogs).values({
    action: "CATALOG_FIELDS_REFRESHED_FROM_FEISHU",
    actorId: input.actorUserId,
    actorType: "ADMIN",
    afterJson: {
      createdProductCount: input.plan.createdProductCount,
      createdSkuCount: input.plan.createdSkuCount,
      degradedSkuCount: input.plan.degradedSkuCount,
      matchedSkuCount: input.plan.matchedSkuCount,
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
}

function previewForPlan(plan: RefreshPlan): CatalogFieldRefreshPreview {
  return {
    cargoPricePlaceholders: [],
    createdProductCount: plan.createdProductCount,
    createdSkuCount: plan.createdSkuCount,
    degradedSkuCount: plan.degradedSkuCount,
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
      reason: string;
      sourceSheetId: string;
      sourceWikiToken: string;
      expectedSourceSequenceCount?: number;
      expectedSkuCount?: number;
    }): Promise<CatalogFieldRefreshPreview> {
      const reason = input.reason.trim();
      if (!reason) fail("OPERATOR_REASON_REQUIRED");

      const runId = randomUUID();
      return await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext('feishu-catalog-field-refresh'))`,
        );
        const source = await prepareSource(input);
        const plan = await buildRefreshPlan(transaction, source);
        const staged = await stageSourceAssets({
          assetDir,
          client: input.client,
          rows: source.rows,
        });
        const storage = createCatalogAssetStorage({ assetDir });
        try {
          const assetBySkuCode = await publishSourceAssets({
            assetDir,
            database: transaction,
            staged,
          });
          await applyPlan({
            actorUserId: input.actorUserId,
            assetBySkuCode,
            database: transaction,
            plan,
            reason,
            runId,
          });
          return previewForPlan(plan);
        } finally {
          await storage.discardStagedAssets(staged.runId).catch(() => undefined);
        }
      });
    },
  };
}
