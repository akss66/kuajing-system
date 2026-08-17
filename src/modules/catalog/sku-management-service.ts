import { asc, count, eq, inArray, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  catalogAssets,
  customerSkuPrices,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  orderImportRows,
  orderLines,
  products,
  skuAliases,
  skus,
} from "@/db/schema";
import { initializeSkuInventory } from "@/modules/inventory/service";
import { roundMilliYuanToFen } from "./unit-price";

export type CatalogManagementErrorCode =
  | "BATCH_LIMIT_EXCEEDED"
  | "INVALID_INPUT"
  | "PRODUCT_NOT_FOUND"
  | "SKU_NOT_FOUND"
  | "SKU_SEQUENCE_MISMATCH";

export class CatalogManagementError extends Error {
  constructor(
    public readonly code: CatalogManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CatalogManagementError";
  }
}

type ProductSelection =
  | { mode: "EXISTING"; productId: string }
  | {
      cargoUnitPriceMilliYuan: number;
      linkText: string | null;
      mode: "CREATE";
      name: string;
      sourceSequence: string;
    };

type SkuFields = {
  color: string | null;
  combination: string | null;
  defaultUnitPriceMilliYuan: number;
  productUrl: string | null;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  skuCode: string;
  specification: string | null;
  weightGrams: number;
};

export type ManagedCatalogImageAsset = {
  byteSize: number;
  contentSha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  originalFileName: string;
  storageKey: string;
};

function requiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new CatalogManagementError("INVALID_INPUT", `${label}不能为空`);
  return normalized;
}

function optionalText(value: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CatalogManagementError("INVALID_INPUT", `${label}必须是非负整数`);
  }
  return value;
}

function normalizedSequence(value: string) {
  const normalized = requiredText(value, "序号");
  if (!/^\d+$/.test(normalized)) {
    throw new CatalogManagementError("INVALID_INPUT", "序号必须是数字");
  }
  return String(Number(normalized));
}

function normalizedProductUrl(value: string | null) {
  const normalized = optionalText(value);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new CatalogManagementError("INVALID_INPUT", "SKU 链接必须是有效网址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CatalogManagementError("INVALID_INPUT", "SKU 链接仅支持 http 或 https");
  }
  return url.toString();
}

function assertSkuMatchesSequence(skuCode: string, sourceSequence: string | null) {
  const match = /^TZX-(\d+)(?:-|$)/i.exec(skuCode.trim());
  if (!match) return;
  if (!sourceSequence || normalizedSequence(match[1]) !== normalizedSequence(sourceSequence)) {
    throw new CatalogManagementError(
      "SKU_SEQUENCE_MISMATCH",
      "TZX SKU 编号与商品序号不一致",
    );
  }
}

function normalizedSku(input: SkuFields) {
  const skuCode = requiredText(input.skuCode, "SKU").toUpperCase();
  const specification = optionalText(input.specification);
  const color = optionalText(input.color);
  return {
    color,
    combination: optionalText(input.combination),
    defaultUnitPriceFen: roundMilliYuanToFen(
      nonNegativeInteger(input.defaultUnitPriceMilliYuan, "采购价"),
    ),
    defaultUnitPriceMilliYuan: input.defaultUnitPriceMilliYuan,
    name: specification || color || skuCode,
    productUrl: normalizedProductUrl(input.productUrl),
    saleStatus: input.saleStatus,
    skuCode,
    specification,
    weightGrams: nonNegativeInteger(input.weightGrams, "重量"),
  };
}

function normalizedImageAsset(asset: ManagedCatalogImageAsset) {
  const contentSha256 = requiredText(asset.contentSha256, "图片摘要").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new CatalogManagementError("INVALID_INPUT", "图片摘要无效");
  }
  const extension = asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType.split("/")[1];
  const expectedStorageKey = `sha256/${contentSha256.slice(0, 2)}/${contentSha256}.${extension}`;
  if (asset.storageKey !== expectedStorageKey) {
    throw new CatalogManagementError("INVALID_INPUT", "图片存储标识无效");
  }
  return {
    byteSize: nonNegativeInteger(asset.byteSize, "图片大小"),
    contentSha256,
    mimeType: asset.mimeType,
    originalFileName: requiredText(asset.originalFileName, "图片文件名").slice(0, 255),
    storageKey: expectedStorageKey,
  };
}

async function persistCatalogImageAsset(
  tx: DbTransaction,
  input: ManagedCatalogImageAsset | null,
) {
  if (!input) return null;
  const imageAsset = normalizedImageAsset(input);
  const [createdAsset] = await tx
    .insert(catalogAssets)
    .values(imageAsset)
    .onConflictDoNothing({ target: catalogAssets.contentSha256 })
    .returning({ id: catalogAssets.id });
  if (createdAsset) return createdAsset.id;
  const [existingAsset] = await tx
    .select({ id: catalogAssets.id })
    .from(catalogAssets)
    .where(eq(catalogAssets.contentSha256, imageAsset.contentSha256))
    .limit(1);
  if (!existingAsset) {
    throw new CatalogManagementError("INVALID_INPUT", "图片资产保存失败");
  }
  return existingAsset.id;
}

async function lockProduct(tx: DbTransaction, productId: string) {
  const rows = await tx.execute<{
    cargoUnitPriceMilliYuan: number | null;
    id: string;
    linkText: string | null;
    name: string;
    sourceSequence: string | null;
    status: "ACTIVE" | "DISABLED";
  }>(sql`
    select
      id,
      cargo_unit_price_milli_yuan as "cargoUnitPriceMilliYuan",
      link_text as "linkText",
      name,
      source_sequence as "sourceSequence",
      status
    from products
    where id = ${productId}
    for update
  `);
  const product = rows[0];
  if (!product) throw new CatalogManagementError("PRODUCT_NOT_FOUND", "商品不存在");
  return product;
}

export async function createManagedSku(input: {
  actorId: string;
  product: ProductSelection;
  reason: string;
  sku: SkuFields & { imageAsset?: ManagedCatalogImageAsset; initialStock: number };
}) {
  const actorId = requiredText(input.actorId, "管理员");
  const reason = requiredText(input.reason, "操作原因");
  const skuInput = normalizedSku(input.sku);
  const initialStock = nonNegativeInteger(input.sku.initialStock, "初始库存");
  const imageAsset = input.sku.imageAsset ?? null;

  return db.transaction(async (tx) => {
    let product: Awaited<ReturnType<typeof lockProduct>>;
    if (input.product.mode === "CREATE") {
      const sourceSequence = normalizedSequence(input.product.sourceSequence);
      const cargoUnitPriceMilliYuan = nonNegativeInteger(
        input.product.cargoUnitPriceMilliYuan,
        "货品价格",
      );
      const [created] = await tx
        .insert(products)
        .values({
          cargoUnitPriceMilliYuan,
          linkText: optionalText(input.product.linkText),
          name: requiredText(input.product.name, "商品名称"),
          sourceSequence,
        })
        .returning({
          cargoUnitPriceMilliYuan: products.cargoUnitPriceMilliYuan,
          id: products.id,
          linkText: products.linkText,
          name: products.name,
          sourceSequence: products.sourceSequence,
          status: products.status,
        });
      product = created;
    } else {
      product = await lockProduct(tx, input.product.productId);
      if (product.status !== "ACTIVE") {
        throw new CatalogManagementError("INVALID_INPUT", "所属商品已停用，无法新增 SKU");
      }
      if (product.cargoUnitPriceMilliYuan === null) {
        throw new CatalogManagementError("INVALID_INPUT", "请先补齐所属商品的货品价格");
      }
    }
    assertSkuMatchesSequence(skuInput.skuCode, product.sourceSequence);

    const imageAssetId = await persistCatalogImageAsset(tx, imageAsset);

    const [sku] = await tx
      .insert(skus)
      .values({
        ...skuInput,
        imageAssetId,
        imageUrl: imageAssetId ? `/api/catalog-assets/${imageAssetId}` : null,
        productId: product.id,
      })
      .returning({ id: skus.id });
    await initializeSkuInventory(tx, { actorId, quantity: initialStock, skuId: sku.id });
    await tx.insert(auditLogs).values({
      action: "SKU_CREATED",
      actorId,
      actorType: "ADMIN",
      afterJson: {
        initialStock,
        productId: product.id,
        saleStatus: skuInput.saleStatus,
        skuCode: skuInput.skuCode,
      },
      beforeJson: {},
      entityId: sku.id,
      entityType: "SKU",
      reason,
    });
    return { productId: product.id, skuId: sku.id };
  });
}

export async function updateManagedProduct(input: {
  actorId: string;
  cargoUnitPriceMilliYuan: number;
  linkText: string | null;
  name: string;
  productId: string;
  reason: string;
  sourceSequence: string;
}) {
  const actorId = requiredText(input.actorId, "管理员");
  const reason = requiredText(input.reason, "操作原因");
  return db.transaction(async (tx) => {
    const before = await lockProduct(tx, input.productId);
    const sourceSequence = normalizedSequence(input.sourceSequence);
    const siblingSkus = await tx
      .select({ id: skus.id, skuCode: skus.skuCode })
      .from(skus)
      .where(eq(skus.productId, input.productId))
      .orderBy(asc(skus.id))
      .for("update");
    for (const sku of siblingSkus) assertSkuMatchesSequence(sku.skuCode, sourceSequence);
    const after = {
      cargoUnitPriceMilliYuan: nonNegativeInteger(input.cargoUnitPriceMilliYuan, "货品价格"),
      linkText: optionalText(input.linkText),
      name: requiredText(input.name, "商品名称"),
      sourceSequence,
      updatedAt: new Date(),
    };
    await tx.update(products).set(after).where(eq(products.id, input.productId));
    await tx.insert(auditLogs).values({
      action: "PRODUCT_UPDATED",
      actorId,
      actorType: "ADMIN",
      afterJson: { ...after, affectedSkuCount: siblingSkus.length },
      beforeJson: before,
      entityId: input.productId,
      entityType: "PRODUCT",
      reason,
    });
    return { affectedSkuCount: siblingSkus.length };
  });
}

export async function updateManagedSku(input: {
  actorId: string;
  imageAsset?: ManagedCatalogImageAsset;
  reason: string;
  skuId: string;
} & SkuFields) {
  const actorId = requiredText(input.actorId, "管理员");
  const reason = requiredText(input.reason, "操作原因");
  const after = normalizedSku(input);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      color: string | null;
      combination: string | null;
      defaultUnitPriceMilliYuan: number;
      imageAssetId: string | null;
      imageUrl: string | null;
      lifecycleStatus: "ACTIVE" | "ARCHIVED";
      productId: string;
      productUrl: string | null;
      saleStatus: "SELLABLE" | "NOT_SELLABLE";
      skuCode: string;
      specification: string | null;
      weightGrams: number | null;
    }>(sql`
      select product_id as "productId", sku_code as "skuCode", specification,
        color, combination, weight_grams as "weightGrams",
        default_unit_price_milli_yuan as "defaultUnitPriceMilliYuan",
        image_asset_id as "imageAssetId", image_url as "imageUrl",
        product_url as "productUrl", sale_status as "saleStatus",
        lifecycle_status as "lifecycleStatus"
      from skus where id = ${input.skuId} for update
    `);
    const before = rows[0];
    if (!before) throw new CatalogManagementError("SKU_NOT_FOUND", "SKU 不存在");
    if (before.lifecycleStatus !== "ACTIVE") {
      throw new CatalogManagementError("INVALID_INPUT", "已归档 SKU 只能先恢复，不能直接修改");
    }
    const product = await lockProduct(tx, before.productId);
    assertSkuMatchesSequence(after.skuCode, product.sourceSequence);
    const imageAssetId = await persistCatalogImageAsset(tx, input.imageAsset ?? null);
    const imageFields = imageAssetId
      ? { imageAssetId, imageUrl: `/api/catalog-assets/${imageAssetId}` }
      : {};
    const persistedAfter = { ...after, ...imageFields };
    await tx.update(skus).set({ ...persistedAfter, updatedAt: new Date() }).where(eq(skus.id, input.skuId));
    await tx.insert(auditLogs).values({
      action: "SKU_UPDATED",
      actorId,
      actorType: "ADMIN",
      afterJson: persistedAfter,
      beforeJson: before,
      entityId: input.skuId,
      entityType: "SKU",
      reason,
    });
  });
}

async function deleteSkuInTransaction(
  tx: DbTransaction,
  input: { actorId: string; reason: string; skuId: string },
) {
  const rows = await tx.execute<{
    lifecycleStatus: "ACTIVE" | "ARCHIVED";
    productId: string;
    saleStatus: "SELLABLE" | "NOT_SELLABLE";
    skuCode: string;
  }>(sql`
    select product_id as "productId", sku_code as "skuCode",
      lifecycle_status as "lifecycleStatus", sale_status as "saleStatus"
    from skus where id = ${input.skuId} for update
  `);
  const sku = rows[0];
  if (!sku) throw new CatalogManagementError("SKU_NOT_FOUND", "SKU 不存在");
  await lockProduct(tx, sku.productId);
  const [balance, movementCount, reservationCount, orderLineCount, importRowCount] = await Promise.all([
    tx.select({ total: inventoryBalances.totalQuantity }).from(inventoryBalances).where(eq(inventoryBalances.skuId, input.skuId)),
    tx.select({ value: count() }).from(inventoryMovements).where(eq(inventoryMovements.skuId, input.skuId)),
    tx.select({ value: count() }).from(inventoryReservations).where(eq(inventoryReservations.skuId, input.skuId)),
    tx.select({ value: count() }).from(orderLines).where(eq(orderLines.skuId, input.skuId)),
    tx.select({ value: count() }).from(orderImportRows).where(eq(orderImportRows.resolvedSkuId, input.skuId)),
  ]);
  const hasHistory =
    (balance[0]?.total ?? 0) !== 0 ||
    (movementCount[0]?.value ?? 0) > 0 ||
    (reservationCount[0]?.value ?? 0) > 0 ||
    (orderLineCount[0]?.value ?? 0) > 0 ||
    (importRowCount[0]?.value ?? 0) > 0;

  if (hasHistory) {
    await tx.update(skus).set({
      archiveReason: input.reason,
      archivedAt: new Date(),
      archivedByAdminUserId: input.actorId,
      lifecycleStatus: "ARCHIVED",
      saleStatus: "NOT_SELLABLE",
      updatedAt: new Date(),
    }).where(eq(skus.id, input.skuId));
    await tx.update(skuAliases).set({ active: false, updatedAt: new Date() }).where(eq(skuAliases.skuId, input.skuId));
    await tx.update(customerSkuPrices).set({ active: false, updatedAt: new Date() }).where(eq(customerSkuPrices.skuId, input.skuId));
    await tx.insert(auditLogs).values({
      action: "SKU_ARCHIVED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: { lifecycleStatus: "ARCHIVED", saleStatus: "NOT_SELLABLE" },
      beforeJson: sku,
      entityId: input.skuId,
      entityType: "SKU",
      reason: input.reason,
    });
    return { mode: "ARCHIVED" as const };
  }

  await tx.delete(customerSkuPrices).where(eq(customerSkuPrices.skuId, input.skuId));
  await tx.delete(skuAliases).where(eq(skuAliases.skuId, input.skuId));
  await tx.delete(inventoryBalances).where(eq(inventoryBalances.skuId, input.skuId));
  await tx.delete(skus).where(eq(skus.id, input.skuId));
  await tx.insert(auditLogs).values({
    action: "SKU_DELETED",
    actorId: input.actorId,
    actorType: "ADMIN",
    afterJson: { deleted: true },
    beforeJson: sku,
    entityId: input.skuId,
    entityType: "SKU",
    reason: input.reason,
  });
  const remaining = await tx.select({ value: count() }).from(skus).where(eq(skus.productId, sku.productId));
  if ((remaining[0]?.value ?? 0) === 0) {
    await tx.delete(products).where(eq(products.id, sku.productId));
  }
  return { mode: "DELETED" as const };
}

export async function deleteManagedSku(input: { actorId: string; reason: string; skuId: string }) {
  const normalized = {
    actorId: requiredText(input.actorId, "管理员"),
    reason: requiredText(input.reason, "删除原因"),
    skuId: input.skuId,
  };
  return db.transaction((tx) => deleteSkuInTransaction(tx, normalized));
}

export async function restoreManagedSku(input: { actorId: string; reason: string; skuId: string }) {
  const actorId = requiredText(input.actorId, "管理员");
  const reason = requiredText(input.reason, "恢复原因");
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      archiveReason: string | null;
      archivedAt: Date | null;
      archivedByAdminUserId: string | null;
      lifecycleStatus: "ACTIVE" | "ARCHIVED";
      productId: string;
      saleStatus: "SELLABLE" | "NOT_SELLABLE";
      skuCode: string;
    }>(sql`
      select product_id as "productId", sku_code as "skuCode",
        lifecycle_status as "lifecycleStatus", sale_status as "saleStatus",
        archived_at as "archivedAt",
        archived_by_admin_user_id as "archivedByAdminUserId",
        archive_reason as "archiveReason"
      from skus where id = ${input.skuId} for update
    `);
    const before = rows[0];
    if (!before) throw new CatalogManagementError("SKU_NOT_FOUND", "SKU 不存在");
    if (before.lifecycleStatus !== "ARCHIVED") {
      throw new CatalogManagementError("INVALID_INPUT", "仅已归档 SKU 可以恢复");
    }
    const product = await lockProduct(tx, before.productId);
    if (product.status !== "ACTIVE") {
      throw new CatalogManagementError("INVALID_INPUT", "所属商品已停用，无法恢复 SKU");
    }
    if (product.cargoUnitPriceMilliYuan === null) {
      throw new CatalogManagementError("INVALID_INPUT", "请先补齐所属商品的货品价格");
    }
    assertSkuMatchesSequence(before.skuCode, product.sourceSequence);
    const after = {
      archiveReason: null,
      archivedAt: null,
      archivedByAdminUserId: null,
      lifecycleStatus: "ACTIVE" as const,
      saleStatus: "NOT_SELLABLE" as const,
      updatedAt: new Date(),
    };
    await tx.update(skus).set(after).where(eq(skus.id, input.skuId));
    await tx.insert(auditLogs).values({
      action: "SKU_RESTORED",
      actorId,
      actorType: "ADMIN",
      afterJson: { lifecycleStatus: after.lifecycleStatus, saleStatus: after.saleStatus },
      beforeJson: before,
      entityId: input.skuId,
      entityType: "SKU",
      reason,
    });
    return { skuId: input.skuId };
  });
}

export type BatchManageSkusInput =
  | { actorId: string; mode: "DELETE"; reason: string; skuIds: string[] }
  | { actorId: string; mode: "MOVE"; productId: string; reason: string; skuIds: string[] }
  | { actorId: string; mode: "SET_STATUS"; reason: string; saleStatus: "SELLABLE" | "NOT_SELLABLE"; skuIds: string[] };

export async function batchManageSkus(input: BatchManageSkusInput) {
  const actorId = requiredText(input.actorId, "管理员");
  const reason = requiredText(input.reason, "批量操作原因");
  const skuIds = [...new Set(input.skuIds)].sort();
  if (skuIds.length === 0) throw new CatalogManagementError("INVALID_INPUT", "请选择 SKU");
  if (skuIds.length > 100) throw new CatalogManagementError("BATCH_LIMIT_EXCEEDED", "一次最多处理 100 个 SKU");

  return db.transaction(async (tx) => {
    const locked = await tx.select({ id: skus.id, lifecycleStatus: skus.lifecycleStatus, skuCode: skus.skuCode }).from(skus)
      .where(inArray(skus.id, skuIds)).orderBy(asc(skus.id)).for("update");
    if (locked.length !== skuIds.length) throw new CatalogManagementError("SKU_NOT_FOUND", "部分 SKU 不存在");
    if (locked.some((sku) => sku.lifecycleStatus !== "ACTIVE")) {
      throw new CatalogManagementError("INVALID_INPUT", "批量操作不支持已归档 SKU，请先逐条恢复");
    }

    if (input.mode === "SET_STATUS") {
      await tx.update(skus).set({ saleStatus: input.saleStatus, updatedAt: new Date() }).where(inArray(skus.id, skuIds));
      for (const sku of locked) await tx.insert(auditLogs).values({ action: "SKU_STATUS_UPDATED", actorId, actorType: "ADMIN", afterJson: { saleStatus: input.saleStatus }, beforeJson: {}, entityId: sku.id, entityType: "SKU", reason });
    } else if (input.mode === "MOVE") {
      const target = await lockProduct(tx, input.productId);
      for (const sku of locked) assertSkuMatchesSequence(sku.skuCode, target.sourceSequence);
      await tx.update(skus).set({ productId: target.id, updatedAt: new Date() }).where(inArray(skus.id, skuIds));
      for (const sku of locked) await tx.insert(auditLogs).values({ action: "SKU_MOVED", actorId, actorType: "ADMIN", afterJson: { productId: target.id }, beforeJson: {}, entityId: sku.id, entityType: "SKU", reason });
    } else {
      for (const skuId of skuIds) await deleteSkuInTransaction(tx, { actorId, reason, skuId });
    }

    await tx.insert(auditLogs).values({
      action: `SKU_BATCH_${input.mode}`,
      actorId,
      actorType: "ADMIN",
      afterJson: { affectedCount: skuIds.length, skuIds },
      beforeJson: {},
      entityId: crypto.randomUUID(),
      entityType: "SKU_BATCH",
      reason,
    });
    return { affectedCount: skuIds.length };
  });
}
