import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  catalogAssets,
  inventoryBalances,
  inventoryMovements,
  products,
  skus,
} from "@/db/schema";
import {
  batchManageSkus,
  CatalogManagementError,
  createManagedSku,
  deleteManagedSku,
  restoreManagedSku,
  updateManagedProduct,
  updateManagedSku,
} from "@/modules/catalog/sku-management-service";

async function resetCatalogManagementFixture() {
  await db.execute(sql.raw(`
    truncate table
      audit_logs,
      catalog_assets,
      inventory_movements,
      inventory_reservations,
      inventory_balances,
      customer_sku_prices,
      sku_aliases,
      order_lines,
      fulfillment_orders,
      order_import_rows,
      order_import_batches,
      skus,
      products
    restart identity cascade
  `));
}

afterEach(resetCatalogManagementFixture);

const actorId = "00000000-0000-4000-8000-00000000a001";

describe("SKU management service", () => {
  test("creates a fully mapped SKU and records initial inventory atomically", async () => {
    const created = await createManagedSku({
      actorId,
      product: {
        linkText: "爆款防爆反光宠物牵引绳",
        mode: "CREATE",
        name: "狗绳",
        sourceSequence: "1",
      },
      reason: "建立首个完整货盘 SKU",
      sku: {
        cargoUnitPriceMilliYuan: 8_000,
        color: "黑色",
        combination: "单件",
        defaultUnitPriceMilliYuan: 2_930,
        initialStock: 12,
        imageAsset: {
          byteSize: 68,
          contentSha256: "a".repeat(64),
          mimeType: "image/png",
          originalFileName: "TZX-001-1.png",
          storageKey: `sha256/${"a".repeat(2)}/${"a".repeat(64)}.png`,
        },
        productUrl: "https://example.test/dog-leash",
        saleStatus: "SELLABLE",
        skuCode: "TZX-001-1",
        specification: "150*80",
        weightGrams: 218,
      },
    });

    const [product] = await db.select().from(products).where(eq(products.id, created.productId));
    const [sku] = await db.select().from(skus).where(eq(skus.id, created.skuId));
    const [balance] = await db.select().from(inventoryBalances).where(eq(inventoryBalances.skuId, created.skuId));
    const [movement] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.skuId, created.skuId));
    const [asset] = await db.select().from(catalogAssets);

    expect(product).toEqual(expect.objectContaining({
      linkText: "爆款防爆反光宠物牵引绳",
      name: "狗绳",
      sourceSequence: "1",
    }));
    expect(sku).toEqual(expect.objectContaining({
      cargoUnitPriceMilliYuan: 8_000,
      color: "黑色",
      combination: "单件",
      defaultUnitPriceMilliYuan: 2_930,
      productUrl: "https://example.test/dog-leash",
      saleStatus: "SELLABLE",
      skuCode: "TZX-001-1",
      specification: "150*80",
      weightGrams: 218,
      imageAssetId: asset?.id,
      imageUrl: `/api/catalog-assets/${asset?.id}`,
    }));
    expect(asset).toEqual(expect.objectContaining({
      byteSize: 68,
      contentSha256: "a".repeat(64),
      mimeType: "image/png",
      originalFileName: "TZX-001-1.png",
    }));
    expect(balance?.totalQuantity).toBe(12);
    expect(movement).toEqual(expect.objectContaining({
      delta: 12,
      reasonCode: "SKU_INITIAL_STOCK",
    }));
  });

  test("adds to an existing product and rejects a mismatched TZX parent number", async () => {
    const [product] = await db.insert(products).values({
      cargoUnitPriceMilliYuan: 1_350,
      name: "A4文件袋",
      sourceSequence: "34",
    }).returning({ id: products.id });

    await expect(createManagedSku({
      actorId,
      product: { mode: "EXISTING", productId: product.id },
      reason: "错误分组验证",
      sku: {
        cargoUnitPriceMilliYuan: 1_350,
        color: null,
        combination: null,
        defaultUnitPriceMilliYuan: 1_350,
        initialStock: 0,
        productUrl: null,
        saleStatus: "SELLABLE",
        skuCode: "TZX-035-1",
        specification: null,
        weightGrams: 68,
      },
    })).rejects.toMatchObject({ code: "SKU_SEQUENCE_MISMATCH" });

    await db.update(products).set({ status: "DISABLED" }).where(eq(products.id, product.id));
    await expect(createManagedSku({
      actorId,
      product: { mode: "EXISTING", productId: product.id },
      reason: "停用商品不应接收新 SKU",
      sku: {
        cargoUnitPriceMilliYuan: 1_350,
        color: null,
        combination: null,
        defaultUnitPriceMilliYuan: 1_350,
        initialStock: 0,
        productUrl: null,
        saleStatus: "NOT_SELLABLE",
        skuCode: "TZX-034-4",
        specification: null,
        weightGrams: 68,
      },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("updates shared product fields and SKU-specific fields with audit history", async () => {
    const created = await createManagedSku({
      actorId,
      product: { linkText: null, mode: "CREATE", name: "头绳", sourceSequence: "4" },
      reason: "初始化",
      sku: { cargoUnitPriceMilliYuan: 5000, color: null, combination: null, defaultUnitPriceMilliYuan: 4000, initialStock: 0, productUrl: null, saleStatus: "SELLABLE", skuCode: "TZX-004", specification: null, weightGrams: 35 },
    });

    await updateManagedProduct({ actorId, linkText: "新链接文字", name: "头绳组合", productId: created.productId, reason: "更新商品资料", sourceSequence: "4" });
    await updateManagedSku({
      actorId,
      cargoUnitPriceMilliYuan: 7000,
      color: "混色",
      combination: "10pcs/包",
      defaultUnitPriceMilliYuan: 5200,
      imageAsset: {
        byteSize: 40,
        contentSha256: "b".repeat(64),
        mimeType: "image/webp",
        originalFileName: "TZX-004.webp",
        storageKey: `sha256/${"b".repeat(2)}/${"b".repeat(64)}.webp`,
      },
      productUrl: "https://example.test/hair",
      reason: "更新 SKU 资料",
      saleStatus: "NOT_SELLABLE",
      skuCode: "TZX-004",
      skuId: created.skuId,
      specification: "米卡其",
      weightGrams: 40,
    });

    const [product] = await db.select().from(products).where(eq(products.id, created.productId));
    const [sku] = await db.select().from(skus).where(eq(skus.id, created.skuId));
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, created.skuId));
    expect(product).toEqual(expect.objectContaining({ name: "头绳组合" }));
    expect(sku).toEqual(expect.objectContaining({
      color: "混色",
      cargoUnitPriceMilliYuan: 7000,
      defaultUnitPriceMilliYuan: 5200,
      imageUrl: expect.stringMatching(/^\/api\/catalog-assets\//),
      saleStatus: "NOT_SELLABLE",
    }));
    expect(audits.map((row) => row.action)).toContain("SKU_UPDATED");
  });

  test("physically deletes unused SKUs, archives historical SKUs, and batch-updates atomically", async () => {
    const first = await createManagedSku({
      actorId,
      product: { linkText: null, mode: "CREATE", name: "商品 10", sourceSequence: "10" },
      reason: "初始化",
      sku: { cargoUnitPriceMilliYuan: 1000, color: null, combination: null, defaultUnitPriceMilliYuan: 500, initialStock: 0, productUrl: null, saleStatus: "SELLABLE", skuCode: "TZX-010-1", specification: null, weightGrams: 1 },
    });
    const second = await createManagedSku({
      actorId,
      product: { mode: "EXISTING", productId: first.productId },
      reason: "初始化",
      sku: { cargoUnitPriceMilliYuan: 1200, color: null, combination: null, defaultUnitPriceMilliYuan: 500, initialStock: 0, productUrl: null, saleStatus: "SELLABLE", skuCode: "TZX-010-2", specification: null, weightGrams: 1 },
    });

    await batchManageSkus({ actorId, mode: "SET_STATUS", reason: "批量下架", saleStatus: "NOT_SELLABLE", skuIds: [second.skuId, first.skuId, second.skuId] });
    expect((await db.select().from(skus)).every((row) => row.saleStatus === "NOT_SELLABLE")).toBe(true);

    await deleteManagedSku({ actorId, reason: "删除未使用 SKU", skuId: second.skuId });
    expect(await db.select().from(skus).where(eq(skus.id, second.skuId))).toHaveLength(0);

    await db.insert(inventoryMovements).values({
      actorId,
      actorType: "ADMIN",
      afterQuantity: 1,
      beforeQuantity: 0,
      delta: 1,
      movementType: "MANUAL_INCREASE",
      reason: "历史",
      reasonCode: "RESTOCK_RECEIPT",
      skuId: first.skuId,
    });
    const archived = await deleteManagedSku({ actorId, reason: "删除历史 SKU", skuId: first.skuId });
    expect(archived.mode).toBe("ARCHIVED");
    expect((await db.select().from(skus).where(eq(skus.id, first.skuId)))[0]).toEqual(expect.objectContaining({ lifecycleStatus: "ARCHIVED", saleStatus: "NOT_SELLABLE" }));

    await expect(batchManageSkus({
      actorId,
      mode: "SET_STATUS",
      reason: "归档 SKU 不允许直接启用",
      saleStatus: "SELLABLE",
      skuIds: [first.skuId],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await restoreManagedSku({ actorId, reason: "恢复历史 SKU 供重新核价", skuId: first.skuId });
    expect((await db.select().from(skus).where(eq(skus.id, first.skuId)))[0]).toEqual(expect.objectContaining({
      archiveReason: null,
      archivedAt: null,
      archivedByAdminUserId: null,
      lifecycleStatus: "ACTIVE",
      saleStatus: "NOT_SELLABLE",
    }));
    expect((await db.select().from(auditLogs).where(eq(auditLogs.entityId, first.skuId))).map((row) => row.action)).toContain("SKU_RESTORED");
  });

  test("rejects oversized batches before changing data", async () => {
    await expect(batchManageSkus({
      actorId,
      mode: "SET_STATUS",
      reason: "越界批量",
      saleStatus: "NOT_SELLABLE",
      skuIds: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    })).rejects.toBeInstanceOf(CatalogManagementError);
  });
});
