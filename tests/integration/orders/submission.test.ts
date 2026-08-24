import { eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  customerSkuPrices,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  orderLines,
  orderShipments,
  products,
  settlementBatches,
  skuAliases,
  skus,
  stores,
  walletAccounts,
  walletHolds,
  walletTransactions,
} from "@/db/schema";
import { getAvailableQuantity } from "@/modules/inventory/queries";
import { createTemuImportPreview } from "@/modules/order-import/service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";
import { submitTemuImportBatch } from "@/modules/orders/submission";
import { cancelFulfillmentOrder } from "@/modules/orders/lifecycle";
import { listAdminOrders, listCustomerOrders } from "@/modules/orders/queries";
import { adjustWalletBalance } from "@/modules/wallet/service";

const baseRow: Record<(typeof TEMU_EXPORT_HEADERS)[number], string | number> = {
  订单号: "PO-SUBMIT-1",
  站点: "加拿大",
  订单状态: "待发货",
  子订单号: "SUB-SUBMIT-1",
  应履约件数: 1,
  商品名称: "提交测试商品",
  SKUID: "SKUID-1",
  SKCID: "SKCID-1",
  SPUID: "SPUID-1",
  SKU货号: "TZX-EXT-SKU-A",
  商品属性: "测试规格",
  收货人姓名: "Submission Recipient",
  收货人联系方式: "+1 613 555 0120",
  备用联系方式: "",
  邮箱: "submit@example.test",
  身份证号: "",
  税号: "",
  详细地址1: "400 Example Street",
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
    worksheet.addRow(TEMU_EXPORT_HEADERS.map((header) => values[header] ?? ""));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createCustomerAndStore() {
  const [customer] = await db
    .insert(customers)
    .values({ code: `C-${crypto.randomUUID()}`, name: "提交客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `提交店铺-${crypto.randomUUID()}` })
    .returning();
  return { customer, store };
}

async function createSku(input: {
  cargoPriceMilliYuan?: number;
  customerId: string;
  storeId: string;
  externalSku: string;
  totalQuantity: number;
  defaultPriceFen: number;
  defaultPriceMilliYuan?: number;
  customerPriceFen?: number;
  saleStatus?: "SELLABLE" | "NOT_SELLABLE";
}) {
  const [product] = await db
    .insert(products)
    .values({
      name: `商品-${input.externalSku}-${crypto.randomUUID()}`,
    })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan:
        input.cargoPriceMilliYuan ??
        input.defaultPriceMilliYuan ??
        input.defaultPriceFen * 10,
      defaultUnitPriceFen: input.defaultPriceFen,
      defaultUnitPriceMilliYuan:
        input.defaultPriceMilliYuan ?? input.defaultPriceFen * 10,
      name: input.externalSku,
      productId: product.id,
      saleStatus: input.saleStatus,
      skuCode: `TZX-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(skuAliases).values({
    externalSku: input.externalSku,
    skuId: sku.id,
    storeId: input.storeId,
  });
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: input.totalQuantity,
  });
  if (input.customerPriceFen !== undefined) {
    await db.insert(customerSkuPrices).values({
      customerId: input.customerId,
      skuId: sku.id,
      unitPriceFen: input.customerPriceFen,
      unitPriceMilliYuan: input.customerPriceFen * 10,
    });
  }
  return sku;
}

async function createPreview(input: {
  customerId: string;
  storeId: string;
  rows: Array<Partial<typeof baseRow>>;
}) {
  return createTemuImportPreview({
    actorUserId: "auth-customer-submit",
    buffer: await workbookBuffer(input.rows),
    customerId: input.customerId,
    fileName: `orders-${crypto.randomUUID()}.xlsx`,
    storeId: input.storeId,
  });
}

describe("atomic TEMU take-order submission", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        wallet_transactions,
        wallet_holds,
        wallet_accounts,
        settlement_batches,
        order_lines,
        order_shipments,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        inventory_reservations,
        inventory_balances,
        customer_sku_prices,
        sku_aliases,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("creates one package, snapshots cargo prices, ignores customer prices and is idempotent", async () => {
    const { customer, store } = await createCustomerAndStore();
    const skuA = await createSku({
      customerId: customer.id,
      cargoPriceMilliYuan: 5_500,
      customerPriceFen: 450,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const skuB = await createSku({
      customerId: customer.id,
      defaultPriceFen: 300,
      externalSku: "TZX-EXT-SKU-B",
      storeId: store.id,
      totalQuantity: 10,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [
        { 应履约件数: 2 },
        { 子订单号: "SUB-SUBMIT-2", SKU货号: "TZX-EXT-SKU-B" },
      ],
    });

    const submitted = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: preview.batchId,
      customerId: customer.id,
    });
    const submittedAgain = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: preview.batchId,
      customerId: customer.id,
    });

    expect(submittedAgain).toEqual(submitted);
    expect(submitted).toMatchObject({
      status: "PENDING_PAYMENT",
      totalAmountFen: 2700,
      totalPackageCount: 1,
      totalQuantity: 3,
    });
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    const shipments = await db.select().from(orderShipments);
    expect(shipments).toHaveLength(1);
    expect(shipments[0].shippingFeeFen).toBe(1_300);
    const lines = await db
      .select()
      .from(orderLines)
      .orderBy(orderLines.externalSubOrderNo);
    expect(lines.map((line) => [line.unitPriceFen, line.lineAmountFen])).toEqual([
      [550, 1100],
      [300, 300],
    ]);
    const reservations = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, submitted.orderId));
    expect(
      reservations
        .map((row) => [row.skuId, row.quantity])
        .sort(([first], [second]) => String(first).localeCompare(String(second))),
    ).toEqual(
      [
        [skuA.id, 2],
        [skuB.id, 1],
      ].sort(([first], [second]) => String(first).localeCompare(String(second))),
    );
    expect(await getAvailableQuantity(db, skuA.id)).toBe(8);
    expect(await getAvailableQuantity(db, skuB.id)).toBe(9);
    const [batch] = await db
      .select()
      .from(orderImportBatches)
      .where(eq(orderImportBatches.id, preview.batchId));
    expect(batch.status).toBe("SUBMITTED");
    const submitAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "FULFILLMENT_ORDER_SUBMITTED"));
    expect(submitAudits).toHaveLength(1);
  });

  test("serializes concurrent previews with the same active sub-order into one stable submission", async () => {
    const { customer, store } = await createCustomerAndStore();
    const sku = await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const [firstPreview, secondPreview] = await Promise.all([
      createPreview({ customerId: customer.id, rows: [{}], storeId: store.id }),
      createPreview({ customerId: customer.id, rows: [{}], storeId: store.id }),
    ]);

    const submissions = await Promise.allSettled(
      [firstPreview, secondPreview].map((preview) =>
        submitTemuImportBatch({
          actorUserId: "auth-customer-submit",
          batchId: preview.batchId,
          customerId: customer.id,
        }),
      ),
    );

    expect(
      submissions.filter((submission) => submission.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = submissions.find(
      (submission) => submission.status === "rejected",
    );
    expect(rejected).toMatchObject({
      reason: {
        code: "NO_READY_ROWS",
        message: "没有可提交的新订单",
        name: "OrderSubmissionError",
      },
      status: "rejected",
    });
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(orderLines)).toHaveLength(1);
    expect(await db.select().from(orderShipments)).toHaveLength(1);
    const reservations = await db.select().from(inventoryReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ quantity: 1, skuId: sku.id });
    expect(await getAvailableQuantity(db, sku.id)).toBe(9);
  });

  test("serializes concurrent previews with one external order and different sub-orders", async () => {
    const { customer, store } = await createCustomerAndStore();
    const sku = await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const [firstPreview, secondPreview] = await Promise.all([
      createPreview({
        customerId: customer.id,
        rows: [{ 子订单号: "SUB-SAME-PACKAGE-1" }],
        storeId: store.id,
      }),
      createPreview({
        customerId: customer.id,
        rows: [{ 子订单号: "SUB-SAME-PACKAGE-2" }],
        storeId: store.id,
      }),
    ]);

    const submissions = await Promise.allSettled(
      [firstPreview, secondPreview].map((preview) =>
        submitTemuImportBatch({
          actorUserId: "auth-customer-submit",
          batchId: preview.batchId,
          customerId: customer.id,
        }),
      ),
    );

    expect(
      submissions.filter((submission) => submission.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      submissions.find((submission) => submission.status === "rejected"),
    ).toMatchObject({
      reason: {
        code: "NO_READY_ROWS",
        message: "没有可提交的新订单",
        name: "OrderSubmissionError",
      },
      status: "rejected",
    });
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(orderShipments)).toHaveLength(1);
    expect(await db.select().from(orderLines)).toHaveLength(1);
    const reservations = await db.select().from(inventoryReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ quantity: 1, skuId: sku.id });
    expect(await getAvailableQuantity(db, sku.id)).toBe(9);
  });

  test("treats a new sub-order under an active external order as a stable duplicate", async () => {
    const { customer, store } = await createCustomerAndStore();
    const sku = await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const firstPreview = await createPreview({
      customerId: customer.id,
      rows: [{}],
      storeId: store.id,
    });
    await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: firstPreview.batchId,
      customerId: customer.id,
    });
    const secondPreview = await createPreview({
      customerId: customer.id,
      rows: [{ 子订单号: "SUB-SUBMIT-NEW" }],
      storeId: store.id,
    });

    await expect(
      submitTemuImportBatch({
        actorUserId: "auth-customer-submit",
        batchId: secondPreview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toMatchObject({
      code: "NO_READY_ROWS",
      message: "没有可提交的新订单",
      name: "OrderSubmissionError",
    });
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(orderShipments)).toHaveLength(1);
    expect(await db.select().from(orderLines)).toHaveLength(1);
    expect(await db.select().from(inventoryReservations)).toHaveLength(1);
    expect(await getAvailableQuantity(db, sku.id)).toBe(9);
  });

  test("a cancelled order releases duplicate protection for an identical re-import", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });

    const firstPreview = await createPreview({
      customerId: customer.id,
      rows: [{}],
      storeId: store.id,
    });
    const firstOrder = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: firstPreview.batchId,
      customerId: customer.id,
    });
    await cancelFulfillmentOrder({
      actorType: "CUSTOMER",
      actorUserId: "auth-customer-submit",
      customerId: customer.id,
      now: new Date("2026-08-18T12:00:00.000Z"),
      orderId: firstOrder.orderId,
      reason: "客户取消后重新下单",
    });

    const secondPreview = await createPreview({
      customerId: customer.id,
      rows: [{}],
      storeId: store.id,
    });
    expect(secondPreview.summary.duplicate).toBe(0);

    const secondOrder = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: secondPreview.batchId,
      customerId: customer.id,
    });
    expect(secondOrder.orderId).not.toBe(firstOrder.orderId);

    const activeOrders = await listAdminOrders({ customerId: customer.id });
    expect(activeOrders.map((row) => row.id)).toEqual([secondOrder.orderId]);
    const cancelledOrders = await listAdminOrders({
      customerId: customer.id,
      status: "CANCELLED",
    });
    expect(cancelledOrders.map((row) => row.id)).toEqual([firstOrder.orderId]);
    expect(
      (await listCustomerOrders(customer.id)).map((row) => row.id),
    ).toEqual([secondOrder.orderId]);
    expect(
      (await listCustomerOrders(customer.id, "CANCELLED")).map((row) => row.id),
    ).toEqual([firstOrder.orderId]);

    const releasedLines = await db
      .select({ deduplicationActive: orderLines.deduplicationActive })
      .from(orderLines)
      .where(eq(orderLines.orderId, firstOrder.orderId));
    const releasedShipments = await db
      .select({ deduplicationActive: orderShipments.deduplicationActive })
      .from(orderShipments)
      .where(eq(orderShipments.orderId, firstOrder.orderId));
    expect(releasedLines.every((row) => !row.deduplicationActive)).toBe(true);
    expect(releasedShipments.every((row) => !row.deduplicationActive)).toBe(true);

    await db
      .update(fulfillmentOrders)
      .set({
        cancellationState: "ALL",
        cancelReason: "结算批次直接取消路径",
        status: "CANCELLED",
      })
      .where(eq(fulfillmentOrders.id, secondOrder.orderId));
    const triggerReleasedLines = await db
      .select({ deduplicationActive: orderLines.deduplicationActive })
      .from(orderLines)
      .where(eq(orderLines.orderId, secondOrder.orderId));
    expect(triggerReleasedLines.every((row) => !row.deduplicationActive)).toBe(true);
  });

  test("rolls back the whole order when any SKU has insufficient inventory", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 5,
    });
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 300,
      externalSku: "TZX-EXT-SKU-B",
      storeId: store.id,
      totalQuantity: 0,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{}, { 子订单号: "SUB-NO-STOCK", SKU货号: "TZX-EXT-SKU-B" }],
    });

    await expect(
      submitTemuImportBatch({
        actorUserId: "auth-customer-submit",
        batchId: preview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_INVENTORY" });

    expect(await db.select().from(fulfillmentOrders)).toEqual([]);
    expect(await db.select().from(inventoryReservations)).toEqual([]);
    const [batch] = await db
      .select()
      .from(orderImportBatches)
      .where(eq(orderImportBatches.id, preview.batchId));
    expect(batch.status).toBe("PREVIEW");
  });

  test("rounds each order line only after multiplying an exact milli-yuan price", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 33,
      defaultPriceMilliYuan: 325,
      externalSku: "TZX-EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [
        { [TEMU_EXPORT_HEADERS[4]]: 2 },
        {
          [TEMU_EXPORT_HEADERS[3]]: "SUB-SUBMIT-2",
          [TEMU_EXPORT_HEADERS[4]]: 3,
        },
      ],
    });

    const submitted = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: preview.batchId,
      customerId: customer.id,
    });
    const lines = await db
      .select({
        lineAmountFen: orderLines.lineAmountFen,
        unitPriceFen: orderLines.unitPriceFen,
        unitPriceMilliYuan: orderLines.unitPriceMilliYuan,
      })
      .from(orderLines)
      .orderBy(orderLines.externalSubOrderNo);

    expect(submitted.totalAmountFen).toBe(1463);
    expect(lines).toEqual([
      { lineAmountFen: 65, unitPriceFen: 33, unitPriceMilliYuan: 325 },
      { lineAmountFen: 98, unitPriceFen: 33, unitPriceMilliYuan: 325 },
    ]);
  });

  test("reclassifies a preview when its SKU becomes not sellable before submission", async () => {
    const { customer, store } = await createCustomerAndStore();
    const sku = await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-BLOCKED",
      storeId: store.id,
      totalQuantity: 5,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ SKU货号: "TZX-EXT-BLOCKED" }],
    });
    expect(preview.summary).toMatchObject({ ready: 1, unknownSku: 0 });
    await db
      .update(skus)
      .set({ saleStatus: "NOT_SELLABLE" })
      .where(eq(skus.id, sku.id));

    await expect(
      submitTemuImportBatch({
        actorUserId: "auth-customer-submit",
        batchId: preview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toMatchObject({ code: "SKU_NOT_SELLABLE" });

    await expect(
      db
        .select({
          readyRows: orderImportBatches.readyRows,
          unknownSkuRows: orderImportBatches.unknownSkuRows,
        })
        .from(orderImportBatches)
        .where(eq(orderImportBatches.id, preview.batchId)),
    ).resolves.toEqual([{ readyRows: 0, unknownSkuRows: 1 }]);
    await expect(
      db
        .select({
          errorCode: orderImportRows.errorCode,
          resolvedSkuId: orderImportRows.resolvedSkuId,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(eq(orderImportRows.batchId, preview.batchId)),
    ).resolves.toEqual([
      {
        errorCode: "SKU_UNAVAILABLE",
        resolvedSkuId: null,
        status: "UNKNOWN_SKU",
      },
    ]);
    expect(await db.select().from(fulfillmentOrders)).toEqual([]);
    expect(await db.select().from(inventoryReservations)).toEqual([]);
  });

  test("submits a customer-supplied-only package with shipping fee and no inventory", async () => {
    const { customer, store } = await createCustomerAndStore();
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ SKU货号: "QS-OWN-1", 应履约件数: 2 }],
    });

    const submitted = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: preview.batchId,
      customerId: customer.id,
    });

    expect(submitted).toMatchObject({
      totalAmountFen: 1_300,
      totalPackageCount: 1,
      totalQuantity: 2,
    });
    expect(await db.select().from(inventoryReservations)).toEqual([]);
    expect(await db.select().from(orderLines)).toEqual([
      expect.objectContaining({
        externalSku: "QS-OWN-1",
        lineAmountFen: 0,
        lineKind: "CUSTOMER_SUPPLIED",
        quantity: 2,
        skuId: null,
        unitPriceFen: 0,
        unitPriceMilliYuan: 0,
      }),
    ]);
    expect(await db.select().from(orderShipments)).toEqual([
      expect.objectContaining({ shippingFeeFen: 1_300 }),
    ]);
  });

  test("prices and reserves only the system portion of a mixed package", async () => {
    const { customer, store } = await createCustomerAndStore();
    const sku = await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-024",
      storeId: store.id,
      totalQuantity: 10,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [
        { SKU货号: "TZX-024-2PCS" },
        { SKU货号: "QS-OWN-2", 子订单号: "SUB-OWN-2" },
      ],
    });

    const submitted = await submitTemuImportBatch({
      actorUserId: "auth-customer-submit",
      batchId: preview.batchId,
      customerId: customer.id,
    });

    expect(submitted).toMatchObject({
      totalAmountFen: 2_300,
      totalPackageCount: 1,
      totalQuantity: 3,
    });
    expect(await db.select().from(inventoryReservations)).toEqual([
      expect.objectContaining({ quantity: 2, skuId: sku.id }),
    ]);
    expect(
      (await db.select().from(orderLines)).map((line) => ({
        amount: line.lineAmountFen,
        kind: line.lineKind,
        quantity: line.quantity,
      })),
    ).toEqual(
      expect.arrayContaining([
        { amount: 1_000, kind: "SYSTEM_SKU", quantity: 2 },
        { amount: 0, kind: "CUSTOMER_SUPPLIED", quantity: 1 },
      ]),
    );
  });

  test("two batches cannot reserve the same final unit", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-LAST-ONE",
      storeId: store.id,
      totalQuantity: 1,
    });
    const first = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-FIRST", 子订单号: "SUB-FIRST", SKU货号: "TZX-EXT-LAST-ONE" }],
    });
    const second = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-SECOND", 子订单号: "SUB-SECOND", SKU货号: "TZX-EXT-LAST-ONE" }],
    });

    const results = await Promise.allSettled([
      submitTemuImportBatch({ actorUserId: "first", batchId: first.batchId, customerId: customer.id }),
      submitTemuImportBatch({ actorUserId: "second", batchId: second.batchId, customerId: customer.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(inventoryReservations)).toHaveLength(1);
  });

  test("auto-debits sufficient balance and serializes concurrent wallet decisions", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "TZX-EXT-WALLET",
      storeId: store.id,
      totalQuantity: 2,
    });
    await adjustWalletBalance({
      actorUserId: "auth-admin-wallet",
      customerId: customer.id,
      deltaFen: 1_800,
      reason: "并发自动扣款测试充值",
    });
    const first = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-WALLET-1", 子订单号: "SUB-WALLET-1", SKU货号: "TZX-EXT-WALLET" }],
    });
    const second = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-WALLET-2", 子订单号: "SUB-WALLET-2", SKU货号: "TZX-EXT-WALLET" }],
    });

    const submitted = await Promise.all([
      submitTemuImportBatch({ actorUserId: "first", batchId: first.batchId, customerId: customer.id }),
      submitTemuImportBatch({ actorUserId: "second", batchId: second.batchId, customerId: customer.id }),
    ]);

    expect(submitted.map((order) => order.status).sort()).toEqual([
      "PAID_PENDING_FULFILLMENT",
      "PENDING_PAYMENT",
    ]);
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(0);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      afterBalanceFen: 0,
      beforeBalanceFen: 1_800,
      deltaFen: -1_800,
    });
    const paidOrder = submitted.find(
      (order) => order.status === "PAID_PENDING_FULFILLMENT",
    )!;
    expect(paidOrder.lockExpiresAt).toBeNull();
    const [paidReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, paidOrder.orderId));
    expect(paidReservation.expiresAt).toBeNull();
  });

  test("does not auto-debit balance reserved by an ACTIVE settlement hold", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 50,
      externalSku: "TZX-EXT-HELD-WALLET",
      storeId: store.id,
      totalQuantity: 1,
    });
    await adjustWalletBalance({
      actorUserId: "auth-admin-wallet",
      customerId: customer.id,
      deltaFen: 100,
      reason: "held funds regression fixture",
    });
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `HELD-${crypto.randomUUID()}`,
        customerId: customer.id,
        idempotencyKey: `held-${crypto.randomUUID()}`,
        offlineAmountFen: 0,
        paymentDueAt: new Date(Date.now() + 60_000),
        totalAmountFen: 80,
        walletAmountFen: 80,
      })
      .returning();
    await db.insert(walletHolds).values({
      amountFen: 80,
      customerId: customer.id,
      settlementBatchId: settlement.id,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [
        {
          订单号: "PO-HELD-WALLET",
          子订单号: "SUB-HELD-WALLET",
          SKU货号: "TZX-EXT-HELD-WALLET",
        },
      ],
    });

    const submitted = await submitTemuImportBatch({
      actorUserId: "held-wallet-order",
      batchId: preview.batchId,
      customerId: customer.id,
    });

    expect(submitted.status).toBe("PENDING_PAYMENT");
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(100);
    const transactions = await db.select().from(walletTransactions);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      afterBalanceFen: 100,
      beforeBalanceFen: 0,
      deltaFen: 100,
      transactionType: "ADMIN_CREDIT",
    });
  });

  test("rejects previews with unresolved SKUs and another customer's batch", async () => {
    const { customer, store } = await createCustomerAndStore();
    const { customer: otherCustomer } = await createCustomerAndStore();
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ SKU货号: "TZX-UNKNOWN" }],
    });

    await expect(
      submitTemuImportBatch({
        actorUserId: "other",
        batchId: preview.batchId,
        customerId: otherCustomer.id,
      }),
    ).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
    await expect(
      submitTemuImportBatch({
        actorUserId: "owner",
        batchId: preview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_NOT_READY" });
    expect(await db.select().from(fulfillmentOrders)).toEqual([]);
  });
});
