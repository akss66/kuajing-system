import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  orderLines,
  orderShipments,
  products,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import {
  applyJifengOrderStatus,
  pollActiveJifengFulfillments,
} from "@/modules/fulfillment/status-sync";

async function createTwoPackageFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [customer] = await db
    .insert(customers)
    .values({ code: `S-${suffix}`, name: "状态同步客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `状态同步店铺-${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `状态同步商品-${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 450,
      name: "发圈",
      productId: product.id,
      skuCode: `TZX-S-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 20 });
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-SYNC-${suffix}`,
      paidAt: new Date(),
      paymentMode: "DIRECT_OFFLINE",
      status: "FULFILLING",
      storeId: store.id,
      totalAmountFen: 1350,
      totalPackageCount: 2,
      totalQuantity: 3,
    })
    .returning();
  const shipments = await db
    .insert(orderShipments)
    .values([
      {
        externalOrderNo: `TEMU-SYNC-A-${suffix}`,
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-a",
        storeId: store.id,
      },
      {
        externalOrderNo: `TEMU-SYNC-B-${suffix}`,
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-b",
        storeId: store.id,
      },
    ])
    .returning();
  await db.insert(orderLines).values(
    shipments.map((shipment, index) => ({
      lineAmountFen: (index + 1) * 450,
      orderId: order.id,
      quantity: index + 1,
      shipmentId: shipment.id,
      skuCodeSnapshot: sku.skuCode,
      skuId: sku.id,
      skuNameSnapshot: sku.name,
      storeId: store.id,
      unitPriceFen: 450,
    })),
  );
  await db.insert(inventoryReservations).values({
    quantity: 3,
    referenceId: order.id,
    referenceType: "FULFILLMENT_ORDER",
    skuId: sku.id,
  });
  const fulfillments = await db
    .insert(shipmentFulfillments)
    .values(
      shipments.map((shipment, index) => ({
        erpNo: `TZX-SYNC-${suffix}-${index + 1}`,
        shipmentId: shipment.id,
        status: "SUBMITTED" as const,
        submittedAt: new Date(),
      })),
    )
    .returning();
  return { fulfillments, order, shipments, sku };
}

describe("Jifeng order status convergence", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        integration_attempts,
        integration_outbox,
        shipment_fulfillments,
        inventory_movements,
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

  test("does not deduct before shipped, deducts each package exactly once, and ships the order only when all packages ship", async () => {
    const fixture = await createTwoPackageFixture();
    const [first, second] = fixture.fulfillments;

    await applyJifengOrderStatus({
      detail: { erpNo: first.erpNo, status: 6 },
      now: new Date("2026-08-12T03:00:00.000Z"),
      source: "POLL",
    });
    let [balance] = await db.select().from(inventoryBalances);
    expect(balance.totalQuantity).toBe(20);
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);

    const shippedAt = new Date("2026-08-12T03:05:00.000Z");
    const firstResult = await applyJifengOrderStatus({
      detail: {
        currency: "CAD",
        erpNo: first.erpNo,
        logisticsFee: 12.34,
        orderNo: "JF-ORDER-1",
        shippedTime: shippedAt.toISOString(),
        status: 7,
        trackingNo: "CP-TRACK-1",
      },
      now: shippedAt,
      source: "POLL",
    });
    expect(firstResult).toEqual({ orderStatus: "FULFILLING", status: "SHIPPED" });
    balance = (await db.select().from(inventoryBalances))[0];
    expect(balance.totalQuantity).toBe(19);
    let [reservation] = await db.select().from(inventoryReservations);
    expect(reservation).toMatchObject({ quantity: 2, status: "ACTIVE" });
    let movements = await db.select().from(inventoryMovements);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      afterQuantity: 19,
      beforeQuantity: 20,
      delta: -1,
      movementType: "SHIPMENT",
      reason: "系统发货扣减",
      reasonCode: "SYSTEM_SHIPMENT",
      referenceId: fixture.shipments[0].id,
      referenceType: "ORDER_SHIPMENT",
    });

    expect(
      await applyJifengOrderStatus({
        detail: {
          currency: "CAD",
          erpNo: first.erpNo,
          logisticsFee: 12.34,
          shippedTime: shippedAt.toISOString(),
          status: 7,
          trackingNo: "CP-TRACK-1",
        },
        now: new Date("2026-08-12T03:06:00.000Z"),
        source: "WEBHOOK",
      }),
    ).toEqual({ orderStatus: "FULFILLING", status: "ALREADY_SHIPPED" });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(19);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);

    const secondResult = await applyJifengOrderStatus({
      detail: {
        currency: "CAD",
        erpNo: second.erpNo,
        logisticsFee: 8,
        shippedTime: "2026-08-12T03:10:00.000Z",
        status: 7,
        trackingNo: "CP-TRACK-2",
      },
      now: new Date("2026-08-12T03:10:00.000Z"),
      source: "POLL",
    });
    expect(secondResult).toEqual({ orderStatus: "SHIPPED", status: "SHIPPED" });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(17);
    reservation = (await db.select().from(inventoryReservations))[0];
    expect(reservation).toMatchObject({ quantity: 2, status: "CONSUMED" });
    movements = await db.select().from(inventoryMovements);
    expect(movements).toHaveLength(2);
    expect(movements.every((movement) => movement.reasonCode === "SYSTEM_SHIPMENT")).toBe(
      true,
    );
    const [updatedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    const updatedShipments = await db.select().from(orderShipments);
    expect(updatedOrder.status).toBe("SHIPPED");
    expect(updatedShipments[0]).toMatchObject({
      logisticsCurrency: "CAD",
      logisticsFeeMinor: 1234,
      shippedAt,
      trackingNumber: "CP-TRACK-1",
    });
    expect(
      (await db.select().from(auditLogs)).filter(
        (entry) => entry.action === "JIFENG_SHIPMENT_SHIPPED",
      ),
    ).toHaveLength(2);
  });

  test("marks Jifeng exception statuses without consuming inventory", async () => {
    const fixture = await createTwoPackageFixture();
    const result = await applyJifengOrderStatus({
      detail: {
        erpNo: fixture.fulfillments[0].erpNo,
        errorCode: 50038,
        errorMsg: "warehouse exception",
        status: 8,
      },
      source: "POLL",
    });

    expect(result).toEqual({ orderStatus: "FULFILLMENT_EXCEPTION", status: "EXCEPTION" });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(20);
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment).toMatchObject({
      jifengStatus: 8,
      lastErrorCode: "50038",
      status: "EXCEPTION",
    });
  });

  test("keeps submitted fulfillments active when a status query temporarily fails", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T08:00:00.000Z");

    await pollActiveJifengFulfillments({
      client: {
        getOrder: async () => {
          throw new Error("temporary response parsing failure");
        },
      },
      now,
    });

    const fulfillments = await db
      .select()
      .from(shipmentFulfillments)
      .orderBy(shipmentFulfillments.erpNo);
    expect(fulfillments).toHaveLength(2);
    expect(fulfillments.every((fulfillment) => fulfillment.status === "SUBMITTED")).toBe(
      true,
    );
    expect(
      fulfillments.every(
        (fulfillment) =>
          fulfillment.lastErrorCode === "STATUS_POLL_FAILED" &&
          fulfillment.nextRetryAt?.toISOString() === "2026-08-18T08:05:00.000Z",
      ),
    ).toBe(true);
    const [order] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    expect(order.status).toBe("FULFILLING");
  });
});
