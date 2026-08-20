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
  systemNotifications,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
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
        system_notifications,
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

  test("releases only the cancelled package reservation and marks the order exceptional", async () => {
    const fixture = await createTwoPackageFixture();
    const cancelledAt = new Date("2026-08-19T02:00:00.000Z");

    const result = await applyJifengOrderStatus({
      detail: {
        erpNo: fixture.fulfillments[0].erpNo,
        orderNo: fixture.shipments[0].externalOrderNo ?? undefined,
        status: 9,
      },
      now: cancelledAt,
      source: "POLL",
    });

    expect(result).toEqual({
      orderStatus: "FULFILLMENT_EXCEPTION",
      status: "CANCELLED",
    });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(20);
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0].status,
    ).toBe("FULFILLMENT_EXCEPTION");
    expect(
      (
        await db
          .select()
          .from(shipmentFulfillments)
          .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id))
      )[0],
    ).toMatchObject({
      cancelledAt,
      jifengStatus: 9,
      nextRetryAt: null,
      status: "CANCELLED",
    });

    expect(
      await applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-19T02:01:00.000Z"),
        source: "WEBHOOK",
      }),
    ).toEqual({
      orderStatus: "FULFILLMENT_EXCEPTION",
      status: "ALREADY_CANCELLED",
    });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
    expect(
      (await db.select().from(auditLogs)).filter(
        (entry) => entry.action === "JIFENG_SHIPMENT_CANCELLED",
      ),
    ).toHaveLength(1);
  });

  test("keeps the parent exceptional when one package ships after its sibling was cancelled", async () => {
    const fixture = await createTwoPackageFixture();

    await applyJifengOrderStatus({
      detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
      now: new Date("2026-08-19T02:00:00.000Z"),
      source: "POLL",
    });
    const result = await applyJifengOrderStatus({
      detail: {
        erpNo: fixture.fulfillments[1].erpNo,
        shippedTime: "2026-08-19T02:05:00.000Z",
        status: 7,
      },
      now: new Date("2026-08-19T02:05:00.000Z"),
      source: "POLL",
    });

    expect(result).toEqual({
      orderStatus: "FULFILLMENT_EXCEPTION",
      status: "SHIPPED",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0].status,
    ).toBe("FULFILLMENT_EXCEPTION");
  });

  test("repairs a previously cancelled package whose parent order stayed fulfilling", async () => {
    const fixture = await createTwoPackageFixture();
    const cancelledAt = new Date("2026-08-18T10:26:15.658Z");
    await db
      .update(shipmentFulfillments)
      .set({ cancelledAt, jifengStatus: 9, status: "CANCELLED" })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    expect(
      await applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-19T02:10:00.000Z"),
        source: "POLL",
      }),
    ).toEqual({
      orderStatus: "FULFILLMENT_EXCEPTION",
      status: "CANCELLED",
    });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0].status,
    ).toBe("FULFILLMENT_EXCEPTION");
    expect(
      (
        await db
          .select()
          .from(shipmentFulfillments)
          .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id))
      )[0].cancelledAt,
    ).toEqual(cancelledAt);
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
          fulfillment.lastErrorCode === null &&
          fulfillment.lastStatusPollErrorCode === "INTERNAL_ERROR" &&
          fulfillment.statusPollFailureCount === 1 &&
          fulfillment.nextRetryAt?.toISOString() === "2026-08-18T08:05:00.000Z",
      ),
    ).toBe(true);
    const [order] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    expect(order.status).toBe("FULFILLING");
  });

  test("reschedules a recovered status-2 fulfillment instead of polling it every minute", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T08:05:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: "STATUS_POLL_FAILED",
        lastErrorMessage: "极风状态查询失败，系统将在稍后重试",
        nextRetryAt: now,
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    await pollActiveJifengFulfillments({
      client: {
        getOrder: async ({ erpNo }) => ({ erpNo, status: 2 }),
      },
      limit: 1,
      now,
    });

    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment).toMatchObject({
      jifengStatus: 2,
      lastErrorCode: null,
      lastErrorMessage: null,
      status: "FULFILLING",
    });
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "2026-08-18T08:10:00.000Z",
    );
  });

  test("does not poll permanent create failures that were never submitted to Jifeng", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T09:00:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: "50026",
        lastErrorMessage: "极风仓库对应 SKU 库存不足，请先同步或补充仓库库存",
        nextRetryAt: null,
        status: "EXCEPTION",
        submittedAt: null,
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-18T10:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));
    let queryCount = 0;

    await pollActiveJifengFulfillments({
      client: {
        getOrder: async ({ erpNo }) => {
          queryCount += 1;
          return { erpNo, status: 2 };
        },
      },
      now,
    });

    expect(queryCount).toBe(0);
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment).toMatchObject({
      lastErrorCode: "50026",
      status: "EXCEPTION",
      submittedAt: null,
    });
  });

  test("backs off transient poll failures without replacing fulfillment errors or warning immediately", async () => {
    const fixture = await createTwoPackageFixture();
    await db
      .update(shipmentFulfillments)
      .set({
        jifengStatus: 8,
        lastErrorCode: "50038",
        lastErrorMessage: "极风报告仓库处理异常，请在极风后台核查",
        status: "EXCEPTION",
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-19T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));
    const client = {
      getOrder: async () => {
        throw new JifengApiError({
          code: "TIMEOUT",
          message: "极风接口请求超时",
          retryable: true,
        });
      },
    };

    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-18T10:00:00.000Z"),
    });
    let [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "2026-08-18T10:05:00.000Z",
    );
    expect(fulfillment).toMatchObject({
      lastErrorCode: "50038",
      lastErrorMessage: "极风报告仓库处理异常，请在极风后台核查",
      status: "EXCEPTION",
    });
    expect(await db.select().from(systemNotifications)).toHaveLength(0);

    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-18T10:05:00.000Z"),
    });
    [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "2026-08-18T10:15:00.000Z",
    );
    expect(await db.select().from(systemNotifications)).toHaveLength(0);

    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-18T10:15:00.000Z"),
    });
    [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "2026-08-18T10:35:00.000Z",
    );
    expect(await db.select().from(systemNotifications)).toHaveLength(1);
  });

  test("uses a slower retry cadence for non-retryable poll errors", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T11:00:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-19T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));

    await pollActiveJifengFulfillments({
      client: {
        getOrder: async () => {
          throw new JifengApiError({
            code: "REFRESH_REQUIRED",
            message: "极风连接需要重新授权",
            retryable: false,
          });
        },
      },
      now,
    });

    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "2026-08-18T11:30:00.000Z",
    );
    expect(await db.select().from(systemNotifications)).toHaveLength(1);
  });

  test("claims due fulfillments so concurrent workers query each package once", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T12:00:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-19T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));
    let queryCount = 0;
    let releaseQuery!: () => void;
    let signalQueryStarted!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const queryStarted = new Promise<void>((resolve) => {
      signalQueryStarted = resolve;
    });
    const client = {
      getOrder: async ({ erpNo }: { erpNo: string }) => {
        queryCount += 1;
        signalQueryStarted();
        await queryGate;
        return { erpNo, status: 2 };
      },
    };

    const firstWorker = pollActiveJifengFulfillments({ client, now });
    await queryStarted;
    const secondWorker = pollActiveJifengFulfillments({ client, now });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseQuery();
    await Promise.all([firstWorker, secondWorker]);

    expect(queryCount).toBe(1);
  });
});
