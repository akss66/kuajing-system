import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  customers,
  fulfillmentOrders,
  integrationOutbox,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  orderLines,
  orderShipments,
  products,
  settlementBatchOrders,
  settlementBatches,
  settlementPaymentClaims,
  shipmentFulfillments,
  shipmentCancellationAdjustments,
  skus,
  stores,
  systemNotifications,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import {
  applyJifengOrderStatus,
  pollActiveJifengFulfillments,
  refreshJifengShipmentStatus,
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
      totalAmountFen: 3950,
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
  return { customer, fulfillments, order, shipments, sku };
}

async function attachUnifiedSettlement(
  fixture: Awaited<ReturnType<typeof createTwoPackageFixture>>,
  status: "PAYMENT_REPORTED" | "PENDING_PAYMENT",
) {
  await db
    .update(fulfillmentOrders)
    .set({ paidAt: null, paymentMode: null, status: "PENDING_PAYMENT" })
    .where(eq(fulfillmentOrders.id, fixture.order.id));
  const [batch] = await db
    .insert(settlementBatches)
    .values({
      batchNumber: `SET-${crypto.randomUUID().slice(0, 8)}`,
      customerId: fixture.customer.id,
      idempotencyKey: `status-sync-${crypto.randomUUID()}`,
      offlineAmountFen: fixture.order.totalAmountFen,
      paymentDueAt: new Date("2026-08-21T00:00:00.000Z"),
      paymentReportedAt:
        status === "PAYMENT_REPORTED"
          ? new Date("2026-08-20T00:00:00.000Z")
          : null,
      status,
      totalAmountFen: fixture.order.totalAmountFen,
      walletAmountFen: 0,
    })
    .returning();
  await db.insert(settlementBatchOrders).values({
    customerId: fixture.customer.id,
    offlineAmountFen: fixture.order.totalAmountFen,
    orderId: fixture.order.id,
    settlementBatchId: batch.id,
    totalAmountFen: fixture.order.totalAmountFen,
    walletAmountFen: 0,
  });
  if (status === "PAYMENT_REPORTED") {
    await db.insert(settlementPaymentClaims).values({
      amountFen: fixture.order.totalAmountFen,
      customerId: fixture.customer.id,
      settlementBatchId: batch.id,
    });
  }
  return batch;
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

  test("does not regress a shipped package when a stale non-terminal webhook arrives", async () => {
    const fixture = await createTwoPackageFixture();
    const fulfillment = fixture.fulfillments[0];

    await applyJifengOrderStatus({
      detail: {
        erpNo: fulfillment.erpNo,
        shippedTime: "2026-08-20T01:00:00.000Z",
        status: 7,
      },
      now: new Date("2026-08-20T01:00:00.000Z"),
      source: "POLL",
    });

    expect(
      await applyJifengOrderStatus({
        detail: { erpNo: fulfillment.erpNo, status: 2 },
        now: new Date("2026-08-20T01:01:00.000Z"),
        source: "WEBHOOK",
      }),
    ).toEqual({ orderStatus: "FULFILLING", status: "ALREADY_SHIPPED" });

    const [updated] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fulfillment.id));
    expect(updated).toMatchObject({ jifengStatus: 7, status: "SHIPPED" });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(19);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);
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

  test("emits one alert for an exception incident, resolves it on recovery, and reopens it on recurrence", async () => {
    const fixture = await createTwoPackageFixture();
    const fulfillment = fixture.fulfillments[0];

    for (const [now, status] of [
      [new Date("2026-08-21T01:00:00.000Z"), 8],
      [new Date("2026-08-21T01:30:00.000Z"), 11],
    ] as const) {
      await applyJifengOrderStatus({
        detail: { erpNo: fulfillment.erpNo, errorCode: 50038, status },
        now,
        source: "POLL",
      });
    }

    let [notification] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.entityId, fixture.shipments[0].id));
    expect(notification).toMatchObject({ occurrenceCount: 1, status: "UNREAD" });
    expect(
      await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.target, "FEISHU_BOT")),
    ).toHaveLength(1);

    await applyJifengOrderStatus({
      detail: { erpNo: fulfillment.erpNo, status: 2 },
      now: new Date("2026-08-21T02:00:00.000Z"),
      source: "POLL",
    });
    [notification] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.entityId, fixture.shipments[0].id));
    expect(notification.status).toBe("RESOLVED");
    expect(notification.resolvedAt?.toISOString()).toBe(
      "2026-08-21T02:00:00.000Z",
    );

    await applyJifengOrderStatus({
      detail: { erpNo: fulfillment.erpNo, errorCode: 50038, status: 8 },
      now: new Date("2026-08-21T03:00:00.000Z"),
      source: "POLL",
    });
    [notification] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.entityId, fixture.shipments[0].id));
    expect(notification).toMatchObject({ occurrenceCount: 2, status: "UNREAD" });
    expect(notification.resolvedAt).toBeNull();
    expect(
      await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.target, "FEISHU_BOT")),
    ).toHaveLength(2);
  });

  test("backs off cancellation confirmation in stages and emits the timeout alert once", async () => {
    const fixture = await createTwoPackageFixture();
    const fulfillment = fixture.fulfillments[0];
    const requestedAt = new Date("2026-08-21T00:00:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: requestedAt, status: "CANCEL_PENDING" })
      .where(eq(shipmentFulfillments.id, fulfillment.id));
    await db.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_CANCEL_REQUESTED",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: { status: "CANCEL_PENDING" },
      beforeJson: { status: "FULFILLING" },
      createdAt: requestedAt,
      entityId: fixture.shipments[0].id,
      entityType: "ORDER_SHIPMENT",
      reason: "测试取消确认退避",
    });

    for (const [now, expectedNext] of [
      ["2026-08-21T00:01:00.000Z", "2026-08-21T00:02:00.000Z"],
      ["2026-08-21T00:20:00.000Z", "2026-08-21T00:25:00.000Z"],
      ["2026-08-21T02:00:00.000Z", "2026-08-21T02:30:00.000Z"],
      ["2026-08-21T07:00:00.000Z", "2026-08-21T09:00:00.000Z"],
      ["2026-08-21T09:00:00.000Z", "2026-08-21T11:00:00.000Z"],
    ] as const) {
      await applyJifengOrderStatus({
        detail: { erpNo: fulfillment.erpNo, status: 2 },
        now: new Date(now),
        source: "POLL",
      });
      const [current] = await db
        .select()
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.id, fulfillment.id));
      expect(current.nextRetryAt?.toISOString()).toBe(expectedNext);
    }

    const timeoutNotifications = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.entityId, fixture.shipments[0].id));
    expect(timeoutNotifications).toHaveLength(1);
    expect(timeoutNotifications[0]).toMatchObject({
      occurrenceCount: 1,
      type: "JIFENG_CANCEL_CONFIRMATION_TIMEOUT",
    });
    expect(
      await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.target, "FEISHU_BOT")),
    ).toHaveLength(1);
  });

  test("replenishes missing shipped metadata without deducting inventory twice", async () => {
    const fixture = await createTwoPackageFixture();
    const fulfillment = fixture.fulfillments[0];
    const firstObservedAt = new Date("2026-08-21T04:00:00.000Z");
    const remoteShippedAt = new Date("2026-08-21T03:45:00.000Z");

    await applyJifengOrderStatus({
      detail: { erpNo: fulfillment.erpNo, status: 7 },
      now: firstObservedAt,
      source: "POLL",
    });
    let [current] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fulfillment.id));
    expect(current.nextRetryAt?.toISOString()).toBe("2026-08-21T10:00:00.000Z");
    expect(current.shippedAt).toBeNull();
    expect(
      (
        await db
          .select()
          .from(orderShipments)
          .where(eq(orderShipments.id, fixture.shipments[0].id))
      )[0].shippedAt,
    ).toBeNull();
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(19);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-22T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));

    let queryCount = 0;
    await pollActiveJifengFulfillments({
      client: {
        getOrder: async ({ erpNo }) => {
          queryCount += 1;
          return {
            currency: "CAD",
            erpNo,
            logisticsFee: 9.5,
            shippedTime: remoteShippedAt.toISOString(),
            status: 7,
            trackingNo: "CP-LATE-TRACKING",
          };
        },
      },
      now: new Date("2026-08-21T10:00:00.000Z"),
    });

    expect(queryCount).toBe(1);
    [current] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fulfillment.id));
    expect(current).toMatchObject({
      nextRetryAt: null,
      shippedAt: remoteShippedAt,
      status: "SHIPPED",
      statusPollClaimToken: null,
      statusPollLockedAt: null,
    });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(19);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(orderShipments)
          .where(eq(orderShipments.id, fixture.shipments[0].id))
      )[0],
    ).toMatchObject({
      logisticsCurrency: "CAD",
      logisticsFeeMinor: 950,
      shippedAt: remoteShippedAt,
      trackingNumber: "CP-LATE-TRACKING",
    });
  });

  test("releases only the cancelled package reservation and keeps the remaining package fulfilling", async () => {
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
      orderStatus: "FULFILLING",
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
    ).toBe("FULFILLING");
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
      orderStatus: "FULFILLING",
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

  test("converges a remote cancellation and invalidates an unpaid unified-settlement quote", async () => {
    const fixture = await createTwoPackageFixture();
    const batch = await attachUnifiedSettlement(fixture, "PENDING_PAYMENT");

    await expect(
      applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-20T03:00:00.000Z"),
        source: "POLL",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    expect(
      (
        await db
          .select()
          .from(settlementBatches)
          .where(eq(settlementBatches.id, batch.id))
      )[0],
    ).toMatchObject({ status: "CANCELLED" });
    expect(
      await db
        .select()
        .from(shipmentCancellationAdjustments)
        .where(
          eq(
            shipmentCancellationAdjustments.shipmentId,
            fixture.shipments[0].id,
          ),
        ),
    ).toHaveLength(1);
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
  });

  test("converges a remote cancellation during payment review and raises reconciliation", async () => {
    const fixture = await createTwoPackageFixture();
    const batch = await attachUnifiedSettlement(fixture, "PAYMENT_REPORTED");

    await expect(
      applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-20T03:10:00.000Z"),
        source: "WEBHOOK",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    expect(
      (
        await db
          .select()
          .from(settlementBatches)
          .where(eq(settlementBatches.id, batch.id))
      )[0],
    ).toMatchObject({ status: "PAYMENT_REPORTED" });
    expect(
      await db
        .select()
        .from(shipmentCancellationAdjustments)
        .where(
          eq(
            shipmentCancellationAdjustments.shipmentId,
            fixture.shipments[0].id,
          ),
        ),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(systemNotifications)
          .where(eq(systemNotifications.entityId, batch.id))
      )[0],
    ).toMatchObject({
      severity: "ERROR",
      type: "SETTLEMENT_REMOTE-CANCELLATION-RECONCILIATION-REQUIRED",
    });
  });

  test("does not regress a cancelled package when a stale non-terminal webhook arrives", async () => {
    const fixture = await createTwoPackageFixture();
    const fulfillment = fixture.fulfillments[0];

    await applyJifengOrderStatus({
      detail: { erpNo: fulfillment.erpNo, status: 9 },
      now: new Date("2026-08-20T02:00:00.000Z"),
      source: "POLL",
    });

    expect(
      await applyJifengOrderStatus({
        detail: { erpNo: fulfillment.erpNo, status: 2 },
        now: new Date("2026-08-20T02:01:00.000Z"),
        source: "WEBHOOK",
      }),
    ).toEqual({
      orderStatus: "FULFILLING",
      status: "ALREADY_CANCELLED",
    });

    const [updated] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fulfillment.id));
    expect(updated).toMatchObject({ jifengStatus: 9, status: "CANCELLED" });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
  });

  test("repairs a stale parent rollup when an adjusted cancellation status is delivered again", async () => {
    const fixture = await createTwoPackageFixture();
    await applyJifengOrderStatus({
      detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
      now: new Date("2026-08-20T02:20:00.000Z"),
      source: "POLL",
    });
    await db
      .update(fulfillmentOrders)
      .set({ status: "FULFILLMENT_EXCEPTION" })
      .where(eq(fulfillmentOrders.id, fixture.order.id));

    await expect(
      applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-20T02:21:00.000Z"),
        source: "WEBHOOK",
      }),
    ).resolves.toEqual({
      orderStatus: "FULFILLING",
      status: "ALREADY_CANCELLED",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0],
    ).toMatchObject({ cancellationState: "PARTIAL", status: "FULFILLING" });
    expect(
      await db
        .select()
        .from(shipmentCancellationAdjustments)
        .where(
          eq(
            shipmentCancellationAdjustments.shipmentId,
            fixture.shipments[0].id,
          ),
        ),
    ).toHaveLength(1);
  });

  test("lets an administrator-triggered refresh repair a cancelled package that is no longer actively polled", async () => {
    const fixture = await createTwoPackageFixture();
    await applyJifengOrderStatus({
      detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
      now: new Date("2026-08-20T02:30:00.000Z"),
      source: "POLL",
    });
    await db
      .update(fulfillmentOrders)
      .set({ status: "FULFILLMENT_EXCEPTION" })
      .where(eq(fulfillmentOrders.id, fixture.order.id));

    await expect(
      refreshJifengShipmentStatus({
        client: {
          async getOrder({ erpNo }) {
            return { erpNo, status: 9 };
          },
        },
        now: new Date("2026-08-20T02:31:00.000Z"),
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({
      orderId: fixture.order.id,
      orderStatus: "FULFILLING",
      status: "ALREADY_CANCELLED",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0],
    ).toMatchObject({ cancellationState: "PARTIAL", status: "FULFILLING" });
    expect(
      (
        await db
          .select()
          .from(shipmentFulfillments)
          .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id))
      )[0],
    ).toMatchObject({
      statusPollClaimToken: null,
      statusPollLockedAt: null,
    });
  });

  test("marks the active remainder shipped when one package ships after its sibling was cancelled", async () => {
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
      orderStatus: "SHIPPED",
      status: "SHIPPED",
    });
    expect(
      (
        await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fixture.order.id))
      )[0].status,
    ).toBe("SHIPPED");
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
      orderStatus: "FULFILLING",
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
    ).toBe("FULFILLING");
    expect(
      (
        await db
          .select()
          .from(shipmentFulfillments)
          .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id))
      )[0].cancelledAt,
    ).toEqual(cancelledAt);
  });

  test("repairs a legacy cancellation adjustment without releasing its inventory twice", async () => {
    const fixture = await createTwoPackageFixture();
    const cancelledAt = new Date("2026-08-18T10:26:15.658Z");
    await db
      .update(shipmentFulfillments)
      .set({ cancelledAt, jifengStatus: 9, status: "CANCELLED" })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    await db
      .update(inventoryReservations)
      .set({ quantity: 2 })
      .where(eq(inventoryReservations.referenceId, fixture.order.id));
    await db.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_CANCELLED",
      actorId: "legacy-admin",
      actorType: "ADMIN",
      afterJson: { status: "CANCELLED" },
      beforeJson: { status: "CANCEL_PENDING" },
      entityId: fixture.shipments[0].id,
      entityType: "ORDER_SHIPMENT",
      reason: "历史版本已释放库存",
    });

    await expect(
      applyJifengOrderStatus({
        detail: { erpNo: fixture.fulfillments[0].erpNo, status: 9 },
        now: new Date("2026-08-20T02:10:00.000Z"),
        source: "WEBHOOK",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      quantity: 2,
      status: "ACTIVE",
    });
    const adjustments = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from shipment_cancellation_adjustments
      where shipment_id = ${fixture.shipments[0].id}
    `);
    expect(adjustments[0].count).toBe(1);
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

  test("rejects a status response for a different ERP number without mutating the other package", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T08:20:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-21T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));

    await pollActiveJifengFulfillments({
      client: {
        getOrder: async () => ({
          erpNo: fixture.fulfillments[1].erpNo,
          orderNo: "JF-WRONG-PACKAGE",
          status: 2,
        }),
      },
      limit: 1,
      now,
    });

    const fulfillments = await db
      .select()
      .from(shipmentFulfillments)
      .orderBy(shipmentFulfillments.erpNo);
    expect(fulfillments[0]).toMatchObject({
      externalOrderNo: null,
      lastStatusPollErrorCode: "INVALID_RESPONSE",
      status: "SUBMITTED",
      statusPollClaimToken: null,
      statusPollFailureCount: 1,
    });
    expect(fulfillments[0].nextRetryAt?.toISOString()).toBe(
      "2026-08-18T08:25:00.000Z",
    );
    expect(fulfillments[1]).toMatchObject({
      externalOrderNo: null,
      jifengStatus: null,
      status: "SUBMITTED",
      statusPollFailureCount: 0,
    });
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

  test("parks a remote-shipped inventory invariant failure across later poll cycles", async () => {
    const fixture = await createTwoPackageFixture();
    await db
      .update(shipmentFulfillments)
      .set({
        jifengStatus: 7,
        lastErrorCode: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
        lastErrorMessage: "极风显示已发货，但本地库存/锁定状态异常",
        nextRetryAt: null,
        status: "EXCEPTION",
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-22T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));
    let queryCount = 0;

    const client = {
      getOrder: async ({ erpNo }: { erpNo: string }) => {
        queryCount += 1;
        return { erpNo, status: 7 };
      },
    };
    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-21T05:00:00.000Z"),
    });
    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-21T11:00:00.000Z"),
    });

    expect(queryCount).toBe(0);
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment).toMatchObject({
      lastErrorCode: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
      status: "EXCEPTION",
      statusPollClaimToken: null,
      statusPollLockedAt: null,
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

  test("parks non-retryable poll errors for manual recovery instead of polling forever", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-18T11:00:00.000Z");
    await db
      .update(shipmentFulfillments)
      .set({ nextRetryAt: new Date("2026-08-21T00:00:00.000Z") })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));

    let queryCount = 0;
    const client = {
      getOrder: async () => {
        queryCount += 1;
        throw new JifengApiError({
          code: "REFRESH_REQUIRED",
          message: "极风连接需要重新授权",
          retryable: false,
        });
      },
    };
    await pollActiveJifengFulfillments({
      client,
      now,
    });

    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    expect(fulfillment.nextRetryAt?.toISOString()).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    expect(await db.select().from(systemNotifications)).toHaveLength(1);
    await pollActiveJifengFulfillments({
      client,
      now: new Date("2026-08-19T11:00:00.000Z"),
    });
    expect(queryCount).toBe(1);
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

  test("claims each package immediately before its remote call so queued leases cannot expire", async () => {
    const fixture = await createTwoPackageFixture();
    const now = new Date("2026-08-21T12:00:00.000Z");
    const queriedErpNumbers: string[] = [];
    let releaseFirstQuery!: () => void;
    let signalFirstQueryStarted!: () => void;
    const firstQueryGate = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    const firstQueryStarted = new Promise<void>((resolve) => {
      signalFirstQueryStarted = resolve;
    });

    const firstWorker = pollActiveJifengFulfillments({
      client: {
        getOrder: async ({ erpNo }) => {
          queriedErpNumbers.push(erpNo);
          signalFirstQueryStarted();
          await firstQueryGate;
          return { erpNo, status: 2 };
        },
      },
      limit: 2,
      now,
    });
    await firstQueryStarted;

    try {
      const claimedRows = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from shipment_fulfillments
        where status_poll_claim_token is not null
      `);
      expect(claimedRows[0].count).toBe(1);

      await expect(
        pollActiveJifengFulfillments({
          client: {
            getOrder: async ({ erpNo }) => {
              queriedErpNumbers.push(erpNo);
              return { erpNo, status: 2 };
            },
          },
          limit: 2,
          now,
        }),
      ).resolves.toMatchObject({ synced: 1 });
    } finally {
      releaseFirstQuery();
      await firstWorker;
    }

    expect(new Set(queriedErpNumbers)).toEqual(
      new Set(fixture.fulfillments.map((fulfillment) => fulfillment.erpNo)),
    );
    expect(queriedErpNumbers).toHaveLength(2);
  });
});
