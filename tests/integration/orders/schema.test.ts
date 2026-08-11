import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  orderImportBatches,
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
