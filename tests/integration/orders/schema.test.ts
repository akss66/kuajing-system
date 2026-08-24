import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  orderImportBatches,
  orderImportRows,
  orderLines,
  products,
  skus,
  stores,
  walletAccounts,
} from "@/db/schema";

async function createCustomer(name: string) {
  const [customer] = await db
    .insert(customers)
    .values({ code: `C-${crypto.randomUUID()}`, name })
    .returning();

  return customer;
}

describe("order, import and settlement schema", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        payment_claims,
        wallet_transactions,
        wallet_accounts,
        order_lines,
        order_shipments,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        sku_aliases,
        customer_sku_prices,
        stores,
        skus,
        products,
        customers
      restart identity cascade
    `));
  });

  test("an import batch cannot combine a customer with another customer's store", async () => {
    const firstCustomer = await createCustomer("甲客户");
    const secondCustomer = await createCustomer("乙客户");
    const [secondStore] = await db
      .insert(stores)
      .values({ customerId: secondCustomer.id, name: "乙店铺" })
      .returning();

    await expect(
      db.insert(orderImportBatches).values({
        customerId: firstCustomer.id,
        storeId: secondStore.id,
        originalFileName: "temu.xlsx",
        fileSha256: "a".repeat(64),
        fileSizeBytes: 1024,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  test("a sub-order number is unique within a store", async () => {
    const customer = await createCustomer("拿货客户");
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "TEMU 渥太华" })
      .returning();
    const [product] = await db
      .insert(products)
      .values({ name: "测试商品" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        productId: product.id,
        skuCode: "TZX-ORDER-SCHEMA",
        name: "测试 SKU",
        defaultUnitPriceFen: 399,
      })
      .returning();
    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        orderNumber: `TH-${Date.now()}`,
        customerId: customer.id,
        storeId: store.id,
        totalAmountFen: 798,
        totalPackageCount: 1,
        totalQuantity: 2,
        lockExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    await db.insert(orderLines).values({
      orderId: order.id,
      storeId: store.id,
      skuId: sku.id,
      externalSubOrderNo: "SUB-001",
      externalSku: "STORE-SKU-1",
      skuCodeSnapshot: sku.skuCode,
      skuNameSnapshot: sku.name,
      quantity: 1,
      unitPriceFen: 399,
      lineAmountFen: 399,
    });

    await expect(
      db.insert(orderLines).values({
        orderId: order.id,
        storeId: store.id,
        skuId: sku.id,
        externalSubOrderNo: "SUB-001",
        externalSku: "STORE-SKU-1",
        skuCodeSnapshot: sku.skuCode,
        skuNameSnapshot: sku.name,
        quantity: 1,
        unitPriceFen: 399,
        lineAmountFen: 399,
      }),
    ).rejects.toThrow();
  });

  test("quantities and monetary amounts cannot be invalid", async () => {
    const customer = await createCustomer("金额约束客户");

    await expect(
      db.insert(walletAccounts).values({
        customerId: customer.id,
        balanceFen: -1,
      }),
    ).rejects.toThrow();

    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "金额测试店铺" })
      .returning();

    await expect(
      db.insert(fulfillmentOrders).values({
        orderNumber: `TH-BAD-${Date.now()}`,
        customerId: customer.id,
        storeId: store.id,
        totalAmountFen: -1,
        totalPackageCount: 0,
        totalQuantity: 0,
        lockExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  test("enforces system and customer-supplied import and order-line identities", async () => {
    const customer = await createCustomer("货品模式约束客户");
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "货品模式店铺" })
      .returning();
    const [product] = await db.insert(products).values({ name: "货品模式商品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({
        cargoUnitPriceMilliYuan: 1_000,
        defaultUnitPriceFen: 100,
        name: "系统规格",
        productId: product.id,
        skuCode: `TZX-MODE-${crypto.randomUUID()}`,
      })
      .returning();
    const [batch] = await db
      .insert(orderImportBatches)
      .values({
        customerId: customer.id,
        expiresAt: new Date(Date.now() + 60_000),
        fileSha256: "b".repeat(64),
        fileSizeBytes: 1,
        originalFileName: "mode.xlsx",
        storeId: store.id,
      })
      .returning();

    await expect(
      db.insert(orderImportRows).values({
        batchId: batch.id,
        effectiveQuantity: 1,
        externalOrderNo: "PO-BAD-SYSTEM",
        externalSku: "TZX-BAD-SYSTEM",
        externalSubOrderNo: "SUB-BAD-SYSTEM",
        fulfillmentMode: "SYSTEM_SKU",
        quantity: 1,
        resolvedSkuId: null,
        rowNumber: 2,
        status: "READY",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(orderImportRows).values({
        batchId: batch.id,
        effectiveQuantity: 1,
        externalOrderNo: "PO-BAD-CUSTOMER",
        externalSku: "SELLER-BAD",
        externalSubOrderNo: "SUB-BAD-CUSTOMER",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        quantity: 1,
        resolutionMethod: "CUSTOMER_SUPPLIED",
        resolvedSkuId: sku.id,
        rowNumber: 3,
        status: "READY",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(orderImportRows).values({
        batchId: batch.id,
        effectiveQuantity: 2,
        externalOrderNo: "PO-GOOD-CUSTOMER",
        externalSku: "SELLER-GOOD",
        externalSubOrderNo: "SUB-GOOD-CUSTOMER",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        quantity: 2,
        resolutionMethod: "CUSTOMER_SUPPLIED",
        resolvedSkuId: null,
        rowNumber: 4,
        status: "READY",
      }),
    ).resolves.toBeDefined();

    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        customerId: customer.id,
        lockExpiresAt: new Date(Date.now() + 60_000),
        orderNumber: `TH-MODE-${crypto.randomUUID().slice(0, 8)}`,
        storeId: store.id,
        totalAmountFen: 1_300,
        totalPackageCount: 1,
        totalQuantity: 2,
      })
      .returning();
    await expect(
      db.insert(orderLines).values({
        lineAmountFen: 0,
        lineKind: "CUSTOMER_SUPPLIED",
        orderId: order.id,
        quantity: 2,
        skuCodeSnapshot: "SELLER-GOOD",
        skuId: null,
        skuNameSnapshot: "客户自有货",
        storeId: store.id,
        unitPriceFen: 0,
        unitPriceMilliYuan: 0,
      }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(orderLines).values({
        lineAmountFen: 100,
        lineKind: "CUSTOMER_SUPPLIED",
        orderId: order.id,
        quantity: 1,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: sku.name,
        storeId: store.id,
        unitPriceFen: 100,
        unitPriceMilliYuan: 1_000,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(orderLines).values({
        lineAmountFen: 0,
        lineKind: "SYSTEM_SKU",
        orderId: order.id,
        quantity: 1,
        skuCodeSnapshot: sku.skuCode,
        skuId: null,
        skuNameSnapshot: sku.name,
        storeId: store.id,
        unitPriceFen: 0,
        unitPriceMilliYuan: 0,
      }),
    ).rejects.toThrow();
  });

  test("a customer has exactly one wallet account", async () => {
    const customer = await createCustomer("钱包客户");

    await db.insert(walletAccounts).values({
      customerId: customer.id,
      balanceFen: 0,
    });

    await expect(
      db.insert(walletAccounts).values({
        customerId: customer.id,
        balanceFen: 100,
      }),
    ).rejects.toThrow();
  });
});
