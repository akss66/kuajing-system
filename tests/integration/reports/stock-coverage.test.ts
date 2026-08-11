import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  integrationOutbox,
  inventoryBalances,
  inventoryReservations,
  orderLines,
  orderShipments,
  products,
  skus,
  stores,
  systemNotifications,
} from "@/db/schema";
import {
  createDailyStockCoverageAlerts,
  getStockCoverageReport,
} from "@/modules/reports/stock-coverage";

describe("stock coverage report and alerts", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        system_notifications,
        order_lines,
        order_shipments,
        fulfillment_orders,
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("uses seven completed Toronto days, available stock and exact 30/40 day boundaries", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values({ code: `COV-${suffix}`, name: "覆盖天数客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: `覆盖天数店铺 ${suffix}` })
      .returning();
    const [product] = await db.insert(products).values({ name: "覆盖天数商品" }).returning();
    const skuRows = await db
      .insert(skus)
      .values([
        { defaultUnitPriceFen: 100, name: "紧急", productId: product.id, skuCode: `COV-30-${suffix}` },
        { defaultUnitPriceFen: 100, name: "预警", productId: product.id, skuCode: `COV-40-${suffix}` },
        { defaultUnitPriceFen: 100, name: "充足", productId: product.id, skuCode: `COV-41-${suffix}` },
        { defaultUnitPriceFen: 100, name: "无基线", productId: product.id, skuCode: `COV-NO-${suffix}` },
      ])
      .returning();
    await db.insert(inventoryBalances).values([
      { skuId: skuRows[0].id, totalQuantity: 35 },
      { skuId: skuRows[1].id, totalQuantity: 40 },
      { skuId: skuRows[2].id, totalQuantity: 41 },
      { skuId: skuRows[3].id, totalQuantity: 10 },
    ]);
    await db.insert(inventoryReservations).values({
      quantity: 5,
      referenceId: "active-order",
      referenceType: "FULFILLMENT_ORDER",
      skuId: skuRows[0].id,
    });
    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        customerId: customer.id,
        orderNumber: `COV-${suffix}`,
        paidAt: new Date("2026-08-11T10:00:00.000Z"),
        paymentMode: "DIRECT_OFFLINE",
        status: "SHIPPED",
        storeId: store.id,
        totalAmountFen: 2_100,
        totalPackageCount: 1,
        totalQuantity: 21,
      })
      .returning();
    const [shipment] = await db
      .insert(orderShipments)
      .values({
        externalOrderNo: `COV-EXT-${suffix}`,
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted",
        shippedAt: new Date("2026-08-11T10:00:00.000Z"),
        storeId: store.id,
      })
      .returning();
    await db.insert(orderLines).values(
      skuRows.slice(0, 3).map((sku) => ({
        lineAmountFen: 700,
        orderId: order.id,
        quantity: 7,
        shipmentId: shipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: `${product.name} · ${sku.name}`,
        storeId: store.id,
        unitPriceFen: 100,
      })),
    );

    const now = new Date("2026-08-12T15:00:00.000Z");
    const report = await getStockCoverageReport({ now });

    expect(report).toEqual([
      expect.objectContaining({ alertLevel: "CRITICAL", availableQuantity: 30, coverageDays: 30, shippedQuantity7d: 7, skuCode: skuRows[0].skuCode }),
      expect.objectContaining({ alertLevel: "WARNING", availableQuantity: 40, coverageDays: 40, shippedQuantity7d: 7, skuCode: skuRows[1].skuCode }),
      expect.objectContaining({ alertLevel: "NONE", availableQuantity: 41, coverageDays: 41, shippedQuantity7d: 7, skuCode: skuRows[2].skuCode }),
      expect.objectContaining({ alertLevel: "NO_BASELINE", availableQuantity: 10, coverageDays: null, shippedQuantity7d: 0, skuCode: skuRows[3].skuCode }),
    ]);

    await expect(createDailyStockCoverageAlerts({ now })).resolves.toBe(2);
    await expect(createDailyStockCoverageAlerts({ now })).resolves.toBe(0);
    expect(await db.select().from(systemNotifications)).toHaveLength(2);
    expect(await db.select().from(integrationOutbox)).toHaveLength(2);
  });
});
