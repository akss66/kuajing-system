import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
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
  SKU货号: "EXACT-KNOWN",
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
      defaultUnitPriceFen: 500,
      name: "黑色",
      productId: product.id,
      skuCode: `TZX-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(skuAliases).values({
    externalSku: "EXACT-KNOWN",
    skuId: sku.id,
    storeId: store.id,
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
    externalSku: "EXACT-KNOWN",
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
      { 子订单号: "SUB-UNKNOWN", SKU货号: "exact-known" },
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
        externalSku: "exact-known",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      });
      await refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "auth-admin-1",
        externalSku: "exact-known",
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
          defaultUnitPriceFen: 500,
          name: "标准 SKU 已下架",
          productId: product.id,
          saleStatus: "NOT_SELLABLE",
          skuCode: "TZX-DIRECT-NOT-SELLABLE",
        },
        {
          defaultUnitPriceFen: 500,
          name: "店铺映射 SKU 已下架",
          productId: product.id,
          saleStatus: "NOT_SELLABLE",
          skuCode: "TZX-" + crypto.randomUUID(),
        },
        {
          archivedAt: new Date(),
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
        externalSku: "STORE-NOT-SELLABLE",
        skuId: fixture.sku.id,
        storeId: null,
      },
      {
        externalSku: "STORE-NOT-SELLABLE",
        skuId: storeNotSellable.id,
        storeId: fixture.store.id,
      },
      {
        externalSku: "GLOBAL-ARCHIVED",
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
          SKU货号: "STORE-NOT-SELLABLE",
          子订单号: "SUB-STORE-NOT-SELLABLE",
        },
        {
          订单号: "PO-GLOBAL-ARCHIVED",
          SKU货号: "GLOBAL-ARCHIVED",
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

  test("does not refresh an unknown preview row to an unavailable mapped SKU", async () => {
    const fixture = await createFixture();
    const preview = await createTemuImportPreview({
      actorUserId: "auth-customer-1",
      buffer: await workbookBuffer([
        {
          SKU货号: "LATER-BLOCKED-ALIAS",
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
        externalSku: "LATER-BLOCKED-ALIAS",
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
          defaultUnitPriceFen: 500,
          name: "标准 SKU",
          productId: product.id,
          skuCode: "TZX-ALIAS-PRIORITY",
        },
        {
          defaultUnitPriceFen: 500,
          name: "全局映射 SKU",
          productId: product.id,
          skuCode: `TZX-${crypto.randomUUID()}`,
        },
        {
          defaultUnitPriceFen: 500,
          name: "店铺映射 SKU",
          productId: product.id,
          skuCode: `TZX-${crypto.randomUUID()}`,
        },
      ])
      .returning();
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
