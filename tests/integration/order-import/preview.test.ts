import { eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  inventoryBalances,
  orderImportBatches,
  orderImportRows,
  orderLines,
  orderShipments,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import {
  createTemuImportPreview,
  getCustomerImportPreview,
  refreshActiveImportPreviewsForAlias,
  updateCustomerImportRowOverride,
} from "@/modules/order-import/service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";
import { decryptPii } from "@/shared/pii-crypto";

const baseRow: Record<(typeof TEMU_EXPORT_HEADERS)[number], string | number> = {
  订单号: "PO-20001",
  站点: "加拿大",
  订单状态: "待发货",
  子订单号: "SUB-READY",
  应履约件数: 1,
  商品名称: "匿名商品",
  SKUID: "SKUID-1",
  SKCID: "SKCID-1",
  SPUID: "SPUID-1",
  SKU货号: "TZX-EXACT-KNOWN",
  商品属性: "黑色",
  收货人姓名: "Preview Recipient",
  收货人联系方式: "+1 613 555 0110",
  备用联系方式: "",
  邮箱: "preview@example.test",
  身份证号: "",
  税号: "",
  详细地址1: "300 Example Street",
  详细地址2: "",
  详细地址3: "",
  区县: "Ottawa",
  城市: "Ottawa",
  省份: "Ontario",
  收货地址邮编: "K1A 0B1",
  国家: "Canada",
  运单号: "",
  物流商: "",
  发货仓: "",
  订单创建时间: "2026-08-12 10:00:00",
  要求最晚发货时间: "2026-08-14 10:00:00",
  实际发货时间: "",
  预计送达时间: "",
  实际签收时间: "",
};

async function workbookBuffer(rows: Array<Partial<typeof baseRow>>) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");
  worksheet.addRow([...TEMU_EXPORT_HEADERS]);
  for (const row of rows) {
    const values = { ...baseRow, ...row };
    worksheet.addRow(
      TEMU_EXPORT_HEADERS.map((header) => values[header] ?? ""),
    );
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createFixture() {
  const [customer] = await db
    .insert(customers)
    .values({ code: `C-${crypto.randomUUID()}`, name: "预览客户" })
    .returning();
  const [otherCustomer] = await db
    .insert(customers)
    .values({ code: `C-${crypto.randomUUID()}`, name: "其他客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "预览店铺" })
    .returning();
  const [otherStore] = await db
    .insert(stores)
    .values({ customerId: otherCustomer.id, name: "其他店铺" })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: "匿名商品" })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: 5_000,
      defaultUnitPriceFen: 500,
      name: "黑色",
      productId: product.id,
      skuCode: `TZX-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(skuAliases).values({
    externalSku: "TZX-EXACT-KNOWN",
    skuId: sku.id,
    storeId: store.id,
  });
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: 100,
  });

  const [existingOrder] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      lockExpiresAt: new Date(Date.now() + 60_000),
      orderNumber: `TH-${crypto.randomUUID()}`,
      storeId: store.id,
      totalAmountFen: 500,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: "TZX-EXACT-KNOWN",
    externalSubOrderNo: "SUB-DUPLICATE",
    lineAmountFen: 500,
    orderId: existingOrder.id,
    quantity: 1,
    skuCodeSnapshot: sku.skuCode,
    skuId: sku.id,
    skuNameSnapshot: sku.name,
    storeId: store.id,
    unitPriceFen: 500,
  });

  return { customer, existingOrder, otherCustomer, otherStore, sku, store };
}

describe("customer-scoped TEMU import preview", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        order_import_rows,
        order_import_batches,
        order_lines,
        fulfillment_orders,
        sku_aliases,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("rejects a store owned by another customer before reading the upload", async () => {
    const fixture = await createFixture();

    await expect(
      createTemuImportPreview({
        actorUserId: "auth-customer-1",
        buffer: Buffer.alloc(0),
        customerId: fixture.customer.id,
        fileName: "orders.xlsx",
        storeId: fixture.otherStore.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_STORE", status: 403 });

    const batches = await db.select().from(orderImportBatches);
    expect(batches).toEqual([]);
  });

  test("persists encrypted rows and classifies exact aliases, duplicates, unknown SKUs and invalid rows", async () => {
    const fixture = await createFixture();
    const buffer = await workbookBuffer([
      {},
      { 子订单号: "SUB-DUPLICATE" },
      { 子订单号: "SUB-UNKNOWN", SKU货号: "TZX-exact-known" },
      { 子订单号: "SUB-INVALID", 应履约件数: 0 },
    ]);

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer,
      customerId: fixture.customer.id,
      fileName: "TEMU订单.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toEqual({
      total: 4,
      ready: 1,
      duplicate: 1,
      unknownSku: 1,
      invalid: 1,
    });

    const persistedRows = await db
      .select()
      .from(orderImportRows)
      .orderBy(orderImportRows.rowNumber);
    expect(persistedRows.map((row) => row.status)).toEqual([
      "READY",
      "DUPLICATE",
      "UNKNOWN_SKU",
      "INVALID",
    ]);

    const encrypted = persistedRows[0].recipientPayloadEncrypted ?? "";
    expect(encrypted).not.toContain("Preview Recipient");
    expect(encrypted).not.toContain("+1 613 555 0110");
    expect(encrypted).not.toContain("300 Example Street");
    expect(decryptPii<{ name: string }>(encrypted).name).toBe(
      "Preview Recipient",
    );
    expect(persistedRows[2].resolvedSkuId).toBeNull();

    await db.transaction(async (tx) => {
      await tx.insert(skuAliases).values({
        externalSku: "TZX-exact-known",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      });
      await refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "auth-admin-1",
        externalSku: "TZX-exact-known",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      });
    });

    await expect(
      getCustomerImportPreview(fixture.customer.id, preview.batchId),
    ).resolves.toMatchObject({
      summary: {
        duplicate: 1,
        invalid: 1,
        ready: 2,
        total: 4,
        unknownSku: 0,
      },
    });
  });

  test("marks later occurrences of the same sub-order in one workbook as duplicates", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        { 子订单号: "SUB-REPEATED-IN-FILE" },
        {
          订单号: "PO-20002",
          子订单号: "SUB-REPEATED-IN-FILE",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "repeated-sub-order.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toEqual({
      total: 2,
      ready: 1,
      duplicate: 1,
      unknownSku: 0,
      invalid: 0,
    });
    expect(preview.rows.map((row) => row.status)).toEqual([
      "READY",
      "DUPLICATE",
    ]);
  });

  test("marks every row in an already active external order as duplicate", async () => {
    const fixture = await createFixture();
    await db.insert(orderShipments).values({
      externalOrderNo: "PO-ACTIVE-PACKAGE",
      orderId: fixture.existingOrder.id,
      recipientPayloadEncrypted: "encrypted-recipient",
      storeId: fixture.store.id,
    });

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          订单号: "PO-ACTIVE-PACKAGE",
          子订单号: "SUB-NEW-IN-ACTIVE-PACKAGE-1",
        },
        {
          订单号: "PO-ACTIVE-PACKAGE",
          子订单号: "SUB-NEW-IN-ACTIVE-PACKAGE-2",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "active-package.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toEqual({
      total: 2,
      ready: 0,
      duplicate: 2,
      unknownSku: 0,
      invalid: 0,
    });
    expect(preview.rows.map((row) => row.status)).toEqual([
      "DUPLICATE",
      "DUPLICATE",
    ]);
  });

  test("stores one encrypted recipient envelope for every line in the same package", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        { 子订单号: "SUB-MIXED-1" },
        { 子订单号: "SUB-MIXED-2" },
      ]),
      customerId: fixture.customer.id,
      fileName: "mixed-package.xlsx",
      storeId: fixture.store.id,
    });

    const rows = await db
      .select({
        recipientPayloadEncrypted: orderImportRows.recipientPayloadEncrypted,
      })
      .from(orderImportRows)
      .where(sql`${orderImportRows.batchId} = ${preview.batchId}`)
      .orderBy(orderImportRows.rowNumber);

    expect(rows).toHaveLength(2);
    expect(rows[0].recipientPayloadEncrypted).toBe(
      rows[1].recipientPayloadEncrypted,
    );
  });

  test("resolves an active standard SKU code when no alias exists", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: fixture.sku.skuCode,
          子订单号: "SUB-STANDARD-SKU",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "standard-sku.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toEqual({
      total: 1,
      ready: 1,
      duplicate: 0,
      unknownSku: 0,
      invalid: 0,
    });
    await expect(
      db
        .select({ resolvedSkuId: orderImportRows.resolvedSkuId })
        .from(orderImportRows)
        .where(sql`${orderImportRows.batchId} = ${preview.batchId}`),
    ).resolves.toEqual([{ resolvedSkuId: fixture.sku.id }]);
  });
  test("normalizes LK and PCS system SKUs while accepting customer-supplied rows", async () => {
    const fixture = await createFixture();
    const [product] = await db
      .insert(products)
      .values({ name: "后缀商品" })
      .returning();
    const [normalizedSku] = await db
      .insert(skus)
      .values({
        cargoUnitPriceMilliYuan: 5_000,
        defaultUnitPriceFen: 500,
        name: "两件装基础 SKU",
        productId: product.id,
        skuCode: "TZX-024",
      })
      .returning();
    await db.insert(inventoryBalances).values({
      skuId: normalizedSku.id,
      totalQuantity: 100,
    });

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        { 子订单号: "SUB-LK", SKU货号: "TZX-024-LK" },
        { 子订单号: "SUB-PCS", SKU货号: "TZX-024-2PCS" },
        { 子订单号: "SUB-EXTERNAL", SKU货号: "QS-014-1-LK" },
      ]),
      customerId: fixture.customer.id,
      fileName: "suffixes.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toMatchObject({ ready: 3, unknownSku: 0 });
    expect(preview.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectiveQuantity: 1,
          externalSku: "TZX-024-LK",
          fulfillmentMode: "SYSTEM_SKU",
          quantityMultiplier: 1,
          resolutionMethod: "NORMALIZED_SUFFIX",
          status: "READY",
        }),
        expect.objectContaining({
          effectiveQuantity: 2,
          externalSku: "TZX-024-2PCS",
          fulfillmentMode: "SYSTEM_SKU",
          quantityMultiplier: 2,
          resolutionMethod: "NORMALIZED_SUFFIX",
          status: "READY",
        }),
        expect.objectContaining({
          effectiveQuantity: 1,
          externalSku: "QS-014-1-LK",
          fulfillmentMode: "CUSTOMER_SUPPLIED",
          resolutionMethod: "CUSTOMER_SUPPLIED",
          status: "READY",
        }),
      ]),
    );

    const persisted = await db
      .select()
      .from(orderImportRows)
      .where(eq(orderImportRows.batchId, preview.batchId));
    expect(
      persisted.find((row) => row.externalSku === "TZX-024-2PCS"),
    ).toMatchObject({
      effectiveQuantity: 2,
      quantityMultiplier: 2,
      resolvedSkuId: normalizedSku.id,
    });
    expect(
      persisted.find((row) => row.externalSku === "QS-014-1-LK"),
    ).toMatchObject({
      fulfillmentMode: "CUSTOMER_SUPPLIED",
      resolvedSkuId: null,
      status: "READY",
    });
  });

  test("blocks every row when aggregate demand for one SKU exceeds available stock", async () => {
    const fixture = await createFixture();
    await db
      .update(inventoryBalances)
      .set({ totalQuantity: 1 })
      .where(eq(inventoryBalances.skuId, fixture.sku.id));

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        { 子订单号: "SUB-AGG-1" },
        { 子订单号: "SUB-AGG-2" },
      ]),
      customerId: fixture.customer.id,
      fileName: "aggregate-shortage.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toMatchObject({ ready: 0, unknownSku: 2 });
    expect(preview.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "INSUFFICIENT_STOCK",
          errorMessage: expect.stringContaining("需 2 件，可用 1 件"),
          status: "UNKNOWN_SKU",
        }),
        expect.objectContaining({
          errorCode: "INSUFFICIENT_STOCK",
          errorMessage: expect.stringContaining("需 2 件，可用 1 件"),
          status: "UNKNOWN_SKU",
        }),
      ]),
    );
  });

  test("updates rows with CAS while preserving the uploaded SKU across fulfillment modes", async () => {
    const fixture = await createFixture();
    const systemPreview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([{}]),
      customerId: fixture.customer.id,
      fileName: "override-system.xlsx",
      storeId: fixture.store.id,
    });
    const systemRow = systemPreview.rows[0];
    const updatedSystem = await updateCustomerImportRowOverride({
      actorUserId: "auth-customer-1",
      batchId: systemPreview.batchId,
      customerId: fixture.customer.id,
      effectiveQuantity: 3,
      expectedRevision: systemRow.revision,
      rowId: systemRow.id,
      skuCode: fixture.sku.skuCode,
    });
    expect(updatedSystem).toMatchObject({
      effectiveQuantity: 3,
      fulfillmentMode: "SYSTEM_SKU",
      resolutionMethod: "MANUAL_OVERRIDE",
      revision: 1,
      status: "READY",
    });
    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "auth-customer-1",
        batchId: systemPreview.batchId,
        customerId: fixture.customer.id,
        effectiveQuantity: 4,
        expectedRevision: 0,
        rowId: systemRow.id,
        skuCode: fixture.sku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_CONFLICT" });

    const externalPreview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        { 订单号: "PO-OWN-OVERRIDE", 子订单号: "SUB-OWN-OVERRIDE", SKU货号: "QS-OWN" },
      ]),
      customerId: fixture.customer.id,
      fileName: "override-customer-supplied.xlsx",
      storeId: fixture.store.id,
    });
    const externalRow = externalPreview.rows[0];
    const updatedExternal = await updateCustomerImportRowOverride({
      actorUserId: "auth-customer-1",
      batchId: externalPreview.batchId,
      customerId: fixture.customer.id,
      effectiveQuantity: 2,
      expectedRevision: externalRow.revision,
      rowId: externalRow.id,
      skuCode: "  SELLER-CHANGED  ",
    });
    expect(updatedExternal).toMatchObject({
      externalSku: "QS-OWN",
      effectiveQuantity: 2,
      fulfillmentMode: "CUSTOMER_SUPPLIED",
      fulfillmentItems: [
        {
          effectiveQuantity: 2,
          fulfillmentMode: "CUSTOMER_SUPPLIED",
          skuCode: "SELLER-CHANGED",
        },
      ],
      resolvedSku: null,
      revision: 1,
    });
    const updatedToSystem = await updateCustomerImportRowOverride({
      actorUserId: "auth-customer-1",
      batchId: externalPreview.batchId,
      customerId: fixture.customer.id,
      effectiveQuantity: 3,
      expectedRevision: 1,
      rowId: externalRow.id,
      skuCode: fixture.sku.skuCode,
    });
    expect(updatedToSystem).toMatchObject({
      externalSku: "QS-OWN",
      effectiveQuantity: 3,
      fulfillmentMode: "SYSTEM_SKU",
      fulfillmentItems: [
        {
          effectiveQuantity: 3,
          fulfillmentMode: "SYSTEM_SKU",
          skuCode: fixture.sku.skuCode,
        },
      ],
      resolvedSku: { id: fixture.sku.id },
      revision: 2,
    });
    await expect(
      db
        .select({ externalSku: orderImportRows.externalSku })
        .from(orderImportRows)
        .where(eq(orderImportRows.id, externalRow.id)),
    ).resolves.toEqual([{ externalSku: "QS-OWN" }]);
  });

  test("persists an expired preview before rejecting a row override", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-expired",
      buffer: await workbookBuffer([{}]),
      customerId: fixture.customer.id,
      fileName: "expired-override.xlsx",
      storeId: fixture.store.id,
    });
    await db
      .update(orderImportBatches)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(orderImportBatches.id, preview.batchId));

    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "auth-customer-expired",
        batchId: preview.batchId,
        customerId: fixture.customer.id,
        effectiveQuantity: 2,
        expectedRevision: preview.rows[0].revision,
        rowId: preview.rows[0].id,
        skuCode: fixture.sku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await expect(
      db
        .select({ status: orderImportBatches.status })
        .from(orderImportBatches)
        .where(eq(orderImportBatches.id, preview.batchId)),
    ).resolves.toEqual([{ status: "EXPIRED" }]);
  });

  test("keeps direct and aliased unavailable SKUs blocked in preview", async () => {
    const fixture = await createFixture();
    const [product] = await db
      .insert(products)
      .values({ name: "不可售预览商品" })
      .returning();
    const [directNotSellable, storeNotSellable, globalArchived] = await db
      .insert(skus)
      .values([
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "标准 SKU 已下架",
          productId: product.id,
          saleStatus: "NOT_SELLABLE",
          skuCode: "TZX-DIRECT-NOT-SELLABLE",
        },
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "店铺映射 SKU 已下架",
          productId: product.id,
          saleStatus: "NOT_SELLABLE",
          skuCode: "TZX-" + crypto.randomUUID(),
        },
        {
          archivedAt: new Date(),
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          lifecycleStatus: "ARCHIVED",
          name: "全局映射 SKU 已归档",
          productId: product.id,
          skuCode: "TZX-" + crypto.randomUUID(),
        },
      ])
      .returning();
    await db.insert(skuAliases).values([
      {
        externalSku: "TZX-STORE-NOT-SELLABLE",
        skuId: fixture.sku.id,
        storeId: null,
      },
      {
        externalSku: "TZX-STORE-NOT-SELLABLE",
        skuId: storeNotSellable.id,
        storeId: fixture.store.id,
      },
      {
        externalSku: "TZX-GLOBAL-ARCHIVED",
        skuId: globalArchived.id,
        storeId: null,
      },
    ]);

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: directNotSellable.skuCode,
          子订单号: "SUB-DIRECT-NOT-SELLABLE",
        },
        {
          订单号: "PO-STORE-NOT-SELLABLE",
          SKU货号: "TZX-STORE-NOT-SELLABLE",
          子订单号: "SUB-STORE-NOT-SELLABLE",
        },
        {
          订单号: "PO-GLOBAL-ARCHIVED",
          SKU货号: "TZX-GLOBAL-ARCHIVED",
          子订单号: "SUB-GLOBAL-ARCHIVED",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "unavailable-skus.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toEqual({
      total: 3,
      ready: 0,
      duplicate: 0,
      unknownSku: 3,
      invalid: 0,
    });
    await expect(
      db
        .select({
          resolvedSkuId: orderImportRows.resolvedSkuId,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(sql`${orderImportRows.batchId} = ${preview.batchId}`)
        .orderBy(orderImportRows.rowNumber),
    ).resolves.toEqual([
      { resolvedSkuId: null, status: "UNKNOWN_SKU" },
      { resolvedSkuId: null, status: "UNKNOWN_SKU" },
      { resolvedSkuId: null, status: "UNKNOWN_SKU" },
    ]);
  });

  test("does not fall through an unavailable exact alias to a normalized base SKU", async () => {
    const fixture = await createFixture();
    const [product] = await db
      .insert(products)
      .values({ name: "后缀优先级商品" })
      .returning();
    const [baseSku, unavailableAliasSku] = await db
      .insert(skus)
      .values([
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "可售基础 SKU",
          productId: product.id,
          skuCode: "TZX-NORMALIZED-BASE",
        },
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "已下架显式映射",
          productId: product.id,
          saleStatus: "NOT_SELLABLE",
          skuCode: `TZX-${crypto.randomUUID()}`,
        },
      ])
      .returning();
    expect(baseSku.saleStatus).toBe("SELLABLE");
    await db.insert(skuAliases).values({
      externalSku: "TZX-NORMALIZED-BASE-LK",
      skuId: unavailableAliasSku.id,
      storeId: fixture.store.id,
    });

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: "TZX-NORMALIZED-BASE-LK",
          子订单号: "SUB-BLOCK-NORMALIZED-FALLBACK",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "blocked-normalized-fallback.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toMatchObject({ ready: 0, unknownSku: 1 });
    expect(preview.rows[0]).toMatchObject({
      externalSku: "TZX-NORMALIZED-BASE-LK",
      status: "UNKNOWN_SKU",
    });

    const refreshed = await db.transaction((tx) =>
      refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "auth-admin-1",
        externalSku: "TZX-NORMALIZED-BASE",
        skuId: baseSku.id,
        storeId: fixture.store.id,
      }),
    );
    expect(refreshed).toBe(0);
    await expect(
      getCustomerImportPreview(fixture.customer.id, preview.batchId),
    ).resolves.toMatchObject({
      rows: [{ status: "UNKNOWN_SKU" }],
      summary: { ready: 0, unknownSku: 1 },
    });
    await expect(
      db
        .select({ resolvedSkuId: orderImportRows.resolvedSkuId })
        .from(orderImportRows)
        .where(eq(orderImportRows.batchId, preview.batchId)),
    ).resolves.toEqual([{ resolvedSkuId: null }]);
  });

  test("refreshes unknown LK and PCS rows after their normalized base alias is added", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          应履约件数: 2,
          SKU货号: "TZX-LATER-NORMALIZED-LK",
          子订单号: "SUB-LATER-NORMALIZED-LK",
        },
        {
          应履约件数: 3,
          SKU货号: "TZX-LATER-NORMALIZED-2PCS",
          子订单号: "SUB-LATER-NORMALIZED-PCS",
        },
        {
          应履约件数: 4,
          SKU货号: "TZX-LATER-NORMALIZED-2PCS-lk",
          子订单号: "SUB-LATER-NORMALIZED-PCS-LK",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "later-normalized-alias.xlsx",
      storeId: fixture.store.id,
    });
    expect(preview.summary).toMatchObject({ ready: 0, unknownSku: 3 });

    await db.insert(skuAliases).values({
      externalSku: "TZX-LATER-NORMALIZED",
      skuId: fixture.sku.id,
      storeId: fixture.store.id,
    });
    const refreshed = await db.transaction((tx) =>
      refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "auth-admin-1",
        externalSku: "TZX-LATER-NORMALIZED",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      }),
    );

    expect(refreshed).toBe(3);
    await expect(
      db
        .select({
          effectiveQuantity: orderImportRows.effectiveQuantity,
          externalSku: orderImportRows.externalSku,
          quantityMultiplier: orderImportRows.quantityMultiplier,
          resolutionMethod: orderImportRows.resolutionMethod,
          resolvedSkuId: orderImportRows.resolvedSkuId,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(eq(orderImportRows.batchId, preview.batchId))
        .orderBy(orderImportRows.rowNumber),
    ).resolves.toEqual([
      {
        effectiveQuantity: 2,
        externalSku: "TZX-LATER-NORMALIZED-LK",
        quantityMultiplier: 1,
        resolutionMethod: "NORMALIZED_SUFFIX",
        resolvedSkuId: fixture.sku.id,
        status: "READY",
      },
      {
        effectiveQuantity: 6,
        externalSku: "TZX-LATER-NORMALIZED-2PCS",
        quantityMultiplier: 2,
        resolutionMethod: "NORMALIZED_SUFFIX",
        resolvedSkuId: fixture.sku.id,
        status: "READY",
      },
      {
        effectiveQuantity: 8,
        externalSku: "TZX-LATER-NORMALIZED-2PCS-lk",
        quantityMultiplier: 2,
        resolutionMethod: "NORMALIZED_SUFFIX",
        resolvedSkuId: fixture.sku.id,
        status: "READY",
      },
    ]);
    await expect(
      getCustomerImportPreview(fixture.customer.id, preview.batchId),
    ).resolves.toMatchObject({
      summary: { ready: 3, unknownSku: 0 },
    });
  });

  test("does not refresh an unknown preview row to an unavailable mapped SKU", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: "TZX-LATER-BLOCKED-ALIAS",
          子订单号: "SUB-LATER-BLOCKED-ALIAS",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "later-blocked-alias.xlsx",
      storeId: fixture.store.id,
    });
    await db
      .update(skus)
      .set({ saleStatus: "NOT_SELLABLE" })
      .where(sql`${skus.id} = ${fixture.sku.id}`);

    const refreshed = await db.transaction((tx) =>
      refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "auth-admin-1",
        externalSku: "TZX-LATER-BLOCKED-ALIAS",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      }),
    );

    expect(refreshed).toBe(0);
    await expect(
      getCustomerImportPreview(fixture.customer.id, preview.batchId),
    ).resolves.toMatchObject({
      rows: [{ status: "UNKNOWN_SKU" }],
      summary: { ready: 0, unknownSku: 1 },
    });
  });

  test("keeps store aliases ahead of global aliases and standard SKU fallback", async () => {
    const fixture = await createFixture();
    const [product] = await db
      .insert(products)
      .values({ name: "映射优先级商品" })
      .returning();
    const [standardSku, globalSku, storeSku] = await db
      .insert(skus)
      .values([
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "标准 SKU",
          productId: product.id,
          skuCode: "TZX-ALIAS-PRIORITY",
        },
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "全局映射 SKU",
          productId: product.id,
          skuCode: `TZX-${crypto.randomUUID()}`,
        },
        {
          cargoUnitPriceMilliYuan: 5_000,
          defaultUnitPriceFen: 500,
          name: "店铺映射 SKU",
          productId: product.id,
          skuCode: `TZX-${crypto.randomUUID()}`,
        },
      ])
      .returning();
    await db.insert(inventoryBalances).values(
      [standardSku, globalSku, storeSku].map((sku) => ({
        skuId: sku.id,
        totalQuantity: 100,
      })),
    );
    await db.insert(skuAliases).values([
      {
        externalSku: standardSku.skuCode,
        skuId: globalSku.id,
        storeId: null,
      },
      {
        externalSku: standardSku.skuCode,
        skuId: storeSku.id,
        storeId: fixture.store.id,
      },
    ]);

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: standardSku.skuCode,
          子订单号: "SUB-STORE-ALIAS",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "alias-priority.xlsx",
      storeId: fixture.store.id,
    });

    await expect(
      db
        .select({ resolvedSkuId: orderImportRows.resolvedSkuId })
        .from(orderImportRows)
        .where(sql`${orderImportRows.batchId} = ${preview.batchId}`),
    ).resolves.toEqual([{ resolvedSkuId: storeSku.id }]);

    await db
      .delete(skuAliases)
      .where(
        sql`${skuAliases.storeId} = ${fixture.store.id} and ${skuAliases.externalSku} = ${standardSku.skuCode}`,
      );
    const globalPreview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: standardSku.skuCode,
          子订单号: "SUB-GLOBAL-ALIAS",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "global-alias-priority.xlsx",
      storeId: fixture.store.id,
    });

    await expect(
      db
        .select({ resolvedSkuId: orderImportRows.resolvedSkuId })
        .from(orderImportRows)
        .where(sql`${orderImportRows.batchId} = ${globalPreview.batchId}`),
    ).resolves.toEqual([{ resolvedSkuId: globalSku.id }]);
  });

  test("does not resolve an archived standard SKU without an alias", async () => {
    const fixture = await createFixture();
    await db
      .update(skus)
      .set({ archivedAt: new Date(), lifecycleStatus: "ARCHIVED" })
      .where(sql`${skus.id} = ${fixture.sku.id}`);

    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: fixture.sku.skuCode,
          子订单号: "SUB-ARCHIVED-SKU",
        },
      ]),
      customerId: fixture.customer.id,
      fileName: "archived-sku.xlsx",
      storeId: fixture.store.id,
    });

    expect(preview.summary).toMatchObject({ ready: 0, unknownSku: 1 });
  });

  test("only returns previews belonging to the requesting customer", async () => {
    const fixture = await createFixture();
    const created = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([{}]),
      customerId: fixture.customer.id,
      fileName: "orders.xlsx",
      storeId: fixture.store.id,
    });

    await expect(
      getCustomerImportPreview(fixture.otherCustomer.id, created.batchId),
    ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    await expect(
      getCustomerImportPreview(fixture.customer.id, created.batchId),
    ).resolves.toMatchObject({ batchId: created.batchId });
  });

  test("rejects a legacy single-store upload whose MIME is not XLSX", async () => {
    const fixture = await createFixture();

    await expect(
      createTemuImportPreview({
        actorUserId: "auth-customer-1",
        buffer: await workbookBuffer([{}]),
        customerId: fixture.customer.id,
        fileName: "orders.xlsx",
        mimeType: "application/octet-stream",
        storeId: fixture.store.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
  });
});
