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
import { InsufficientInventoryError } from "@/modules/inventory/service";
import { createTemuImportPreview } from "@/modules/order-import/service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";
import { submitTemuImportBatch } from "@/modules/orders/submission";
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
  SKU货号: "EXT-SKU-A",
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
      cargoUnitPriceMilliYuan:
        input.cargoPriceMilliYuan ??
        input.defaultPriceMilliYuan ??
        input.defaultPriceFen * 10,
      name: `商品-${input.externalSku}-${crypto.randomUUID()}`,
    })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
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
      externalSku: "EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 10,
    });
    const skuB = await createSku({
      customerId: customer.id,
      defaultPriceFen: 300,
      externalSku: "EXT-SKU-B",
      storeId: store.id,
      totalQuantity: 10,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [
        { 应履约件数: 2 },
        { 子订单号: "SUB-SUBMIT-2", SKU货号: "EXT-SKU-B" },
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
      totalAmountFen: 1400,
      totalPackageCount: 1,
      totalQuantity: 3,
    });
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(orderShipments)).toHaveLength(1);
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

  test("rolls back the whole order when any SKU has insufficient inventory", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "EXT-SKU-A",
      storeId: store.id,
      totalQuantity: 5,
    });
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 300,
      externalSku: "EXT-SKU-B",
      storeId: store.id,
      totalQuantity: 0,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{}, { 子订单号: "SUB-NO-STOCK", SKU货号: "EXT-SKU-B" }],
    });

    await expect(
      submitTemuImportBatch({
        actorUserId: "auth-customer-submit",
        batchId: preview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

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
      externalSku: "EXT-SKU-A",
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

    expect(submitted.totalAmountFen).toBe(163);
    expect(lines).toEqual([
      { lineAmountFen: 65, unitPriceFen: 33, unitPriceMilliYuan: 325 },
      { lineAmountFen: 98, unitPriceFen: 33, unitPriceMilliYuan: 325 },
    ]);
  });

  test("rejects a manually not-sellable SKU even when stock is available", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "EXT-BLOCKED",
      saleStatus: "NOT_SELLABLE",
      storeId: store.id,
      totalQuantity: 5,
    });
    const preview = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ SKU货号: "EXT-BLOCKED" }],
    });

    await expect(
      submitTemuImportBatch({
        actorUserId: "auth-customer-submit",
        batchId: preview.batchId,
        customerId: customer.id,
      }),
    ).rejects.toMatchObject({ code: "SKU_NOT_SELLABLE" });

    expect(await db.select().from(fulfillmentOrders)).toEqual([]);
    expect(await db.select().from(inventoryReservations)).toEqual([]);
  });

  test("two batches cannot reserve the same final unit", async () => {
    const { customer, store } = await createCustomerAndStore();
    await createSku({
      customerId: customer.id,
      defaultPriceFen: 500,
      externalSku: "EXT-LAST-ONE",
      storeId: store.id,
      totalQuantity: 1,
    });
    const first = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-FIRST", 子订单号: "SUB-FIRST", SKU货号: "EXT-LAST-ONE" }],
    });
    const second = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-SECOND", 子订单号: "SUB-SECOND", SKU货号: "EXT-LAST-ONE" }],
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
      externalSku: "EXT-WALLET",
      storeId: store.id,
      totalQuantity: 2,
    });
    await adjustWalletBalance({
      actorUserId: "auth-admin-wallet",
      customerId: customer.id,
      deltaFen: 500,
      reason: "并发自动扣款测试充值",
    });
    const first = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-WALLET-1", 子订单号: "SUB-WALLET-1", SKU货号: "EXT-WALLET" }],
    });
    const second = await createPreview({
      customerId: customer.id,
      storeId: store.id,
      rows: [{ 订单号: "PO-WALLET-2", 子订单号: "SUB-WALLET-2", SKU货号: "EXT-WALLET" }],
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
      beforeBalanceFen: 500,
      deltaFen: -500,
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
      externalSku: "EXT-HELD-WALLET",
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
          SKU货号: "EXT-HELD-WALLET",
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
      rows: [{ SKU货号: "UNKNOWN" }],
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
