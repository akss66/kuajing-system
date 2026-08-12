import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  customers,
  fulfillmentOrders,
  integrationAttempts,
  integrationOutbox,
  inventoryBalances,
  inventoryReservations,
  orderLines,
  orderShipments,
  products,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import type { JifengCreateOrderInput } from "@/integrations/jifeng/types";
import {
  enqueuePaidOrdersForFulfillment,
  processDueJifengCreateOrderEvents,
  processJifengCreateOrderEvent,
  retryJifengShipment,
  type JifengCreateOrderPort,
} from "@/modules/fulfillment/dispatch";
import { cancelFulfillmentOrder } from "@/modules/orders/lifecycle";
import type { TemuRecipient } from "@/modules/order-import/temu-parser";
import { encryptPii } from "@/shared/pii-crypto";

const recipient: TemuRecipient = {
  addressLine1: "400 Example Street",
  addressLine2: "Unit 8",
  addressLine3: null,
  alternatePhone: null,
  city: "Ottawa",
  country: "Canada",
  district: "Ottawa",
  email: "recipient@example.test",
  identityNumber: null,
  name: "Fulfillment Recipient",
  phone: "+1 613 555 0120",
  postalCode: "K1A 0B1",
  province: "Ontario",
  taxNumber: null,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createShipmentFixture(
  status: "PAID_PENDING_FULFILLMENT" | "PENDING_PAYMENT" =
    "PAID_PENDING_FULFILLMENT",
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [customer] = await db
    .insert(customers)
    .values({ code: `D-${suffix}`, name: "履约客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `TEMU 渥太华店-${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `履约商品-${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 450,
      name: "头绳 黑色",
      productId: product.id,
      skuCode: `TZX-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 20 });
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-D-${suffix}`,
      paidAt: status === "PAID_PENDING_FULFILLMENT" ? new Date() : null,
      paymentMode: status === "PAID_PENDING_FULFILLMENT" ? "DIRECT_OFFLINE" : null,
      status,
      storeId: store.id,
      totalAmountFen: 900,
      totalPackageCount: 1,
      totalQuantity: 2,
    })
    .returning();
  const [shipment] = await db
    .insert(orderShipments)
    .values({
      externalOrderNo: `TEMU-${suffix}`,
      orderId: order.id,
      recipientPayloadEncrypted: encryptPii(recipient),
      storeId: store.id,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: `EXT-${suffix}`,
    lineAmountFen: 900,
    orderId: order.id,
    quantity: 2,
    shipmentId: shipment.id,
    skuCodeSnapshot: sku.skuCode,
    skuId: sku.id,
    skuNameSnapshot: sku.name,
    storeId: store.id,
    unitPriceFen: 450,
  });
  await db.insert(inventoryReservations).values({
    quantity: 2,
    referenceId: order.id,
    referenceType: "FULFILLMENT_ORDER",
    skuId: sku.id,
  });
  return { order, shipment, sku, store };
}

describe("paid order Jifeng dispatch", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        integration_attempts,
        integration_outbox,
        shipment_fulfillments,
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

  test("enqueues each paid shipment once and never copies recipient PII into the outbox", async () => {
    const paid = await createShipmentFixture();
    await createShipmentFixture("PENDING_PAYMENT");

    expect(await enqueuePaidOrdersForFulfillment()).toBe(1);
    expect(await enqueuePaidOrdersForFulfillment()).toBe(0);

    const fulfillmentRows = await db.select().from(shipmentFulfillments);
    const outboxRows = await db.select().from(integrationOutbox);
    expect(fulfillmentRows).toHaveLength(1);
    expect(fulfillmentRows[0]).toMatchObject({
      erpNo: `TZX-${paid.shipment.id.replaceAll("-", "")}`,
      shipmentId: paid.shipment.id,
      status: "PENDING",
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      eventType: "JIFENG_CREATE_ORDER",
      idempotencyKey: `jifeng:create:${paid.shipment.id}`,
      payload: { shipmentId: paid.shipment.id },
      status: "PENDING",
      target: "JIFENG",
    });
    expect(JSON.stringify(outboxRows[0].payload)).not.toContain(recipient.phone);
    expect(JSON.stringify(outboxRows[0].payload)).not.toContain(recipient.addressLine1);
  });

  test("decrypts the address only when submitting and records a successful attempt", async () => {
    const { order, shipment, sku, store } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    let submitted: JifengCreateOrderInput | undefined;
    const client: JifengCreateOrderPort = {
      async createOrder(input) {
        submitted = input;
        return { data: null, requestId: "request-success" };
      },
    };

    const result = await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: new Date("2026-08-12T02:00:00.000Z"),
    });

    expect(result).toEqual({ status: "COMPLETED" });
    expect(submitted).toMatchObject({
      amount: 9,
      buyerName: recipient.name,
      buyerPhone: recipient.phone,
      currency: "CNY",
      erpNo: `TZX-${shipment.id.replaceAll("-", "")}`,
      logisticsId: 310,
      platform: "temu",
      platformOrderNo: shipment.externalOrderNo,
      recipientAddress: recipient.addressLine1,
      recipientAddress2: recipient.addressLine2,
      recipientArea: recipient.district,
      recipientCity: recipient.city,
      recipientCountry: "CA",
      recipientEmail: recipient.email,
      recipientProvince: recipient.province,
      shopName: store.name,
      type: 2,
      warehouse: "CA-YYZ",
      zipCode: recipient.postalCode,
    });
    expect(submitted?.skuList).toEqual([
      { itemNameCn: sku.name, num: 2, sku: sku.skuCode, unitPrice: 4.5 },
    ]);

    const [updatedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    const [updatedEvent] = await db.select().from(integrationOutbox);
    const [attempt] = await db.select().from(integrationAttempts);
    const dispatchAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_ORDER_SUBMITTED"));
    expect(updatedOrder.status).toBe("FULFILLING");
    expect(fulfillment).toMatchObject({ attemptCount: 1, status: "SUBMITTED" });
    expect(updatedEvent).toMatchObject({ attemptCount: 1, status: "COMPLETED" });
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      outcome: "SUCCESS",
      responseMetadata: { requestId: "request-success" },
    });
    expect(dispatchAudits).toHaveLength(1);
  });

  test("never calls Jifeng for an event whose local order cancellation already committed", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: "admin-user",
      orderId: order.id,
      reason: "cancel before queued dispatch",
    });
    let apiCalls = 0;

    const result = await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          apiCalls += 1;
          return { data: null };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });

    expect(result).toEqual({ status: "SKIPPED_CANCELLED" });
    expect(apiCalls).toBe(0);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedOrder.status).toBe("CANCELLED");
    expect(fulfillment.status).toBe("CANCELLED");
    expect(savedEvent.status).toBe("COMPLETED");
  });

  test("blocks local cancellation after the dispatch claim crosses the safe boundary", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const gate = deferred();
    let apiCalls = 0;
    const dispatch = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          apiCalls += 1;
          await gate.promise;
          return { data: null };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    for (let attempt = 0; attempt < 100 && apiCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(apiCalls).toBe(1);

    await expect(
      cancelFulfillmentOrder({
        actorType: "ADMIN",
        actorUserId: "admin-user",
        orderId: order.id,
        reason: "too late for local cancel",
      }),
    ).rejects.toMatchObject({ code: "FULFILLMENT_CANCEL_REQUIRED" });
    gate.resolve();
    await expect(dispatch).resolves.toEqual({ status: "COMPLETED" });
  });

  test("keeps only a safe failure summary and schedules retryable errors", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const client: JifengCreateOrderPort = {
      async createOrder() {
        throw new JifengApiError({
          code: "HTTP_503",
          message: "极风接口网络响应异常（503）",
          retryable: true,
        });
      },
    };
    const now = new Date("2026-08-12T02:00:00.000Z");

    const result = await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now,
    });

    expect(result).toEqual({ status: "RETRY_SCHEDULED" });
    const [updatedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    const [updatedEvent] = await db.select().from(integrationOutbox);
    const [attempt] = await db.select().from(integrationAttempts);
    expect(updatedOrder.status).toBe("PAID_PENDING_FULFILLMENT");
    expect(fulfillment).toMatchObject({
      attemptCount: 1,
      lastErrorCode: "HTTP_503",
      status: "EXCEPTION",
    });
    expect(updatedEvent).toMatchObject({
      attemptCount: 1,
      lastErrorCode: "HTTP_503",
      status: "FAILED",
    });
    expect(updatedEvent.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(attempt).toMatchObject({
      errorCode: "HTTP_503",
      outcome: "RETRYABLE_FAILURE",
    });
    expect(JSON.stringify(updatedEvent)).not.toContain(recipient.phone);
    expect(JSON.stringify(updatedEvent)).not.toContain(recipient.addressLine1);
  });

  test.each(["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"])(
    "blocks local cancellation after an ambiguous %s create attempt",
    async (errorCode) => {
      const { order } = await createShipmentFixture();
      await enqueuePaidOrdersForFulfillment();
      const [event] = await db.select().from(integrationOutbox);
      await processJifengCreateOrderEvent({
        client: {
          async createOrder() {
            throw new JifengApiError({
              code: errorCode,
              message: "ambiguous outbound failure",
              retryable: true,
            });
          },
        },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
      });

      await expect(
        cancelFulfillmentOrder({
          actorType: "ADMIN",
          actorUserId: "admin-user",
          orderId: order.id,
          reason: "must reconcile before cancellation",
        }),
      ).rejects.toMatchObject({ code: "FULFILLMENT_CANCEL_REQUIRED" });

      const [savedOrder] = await db
        .select()
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, order.id));
      const [reservation] = await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.referenceId, order.id));
      expect(savedOrder.status).not.toBe("CANCELLED");
      expect(reservation.status).toBe("ACTIVE");
    },
  );

  test("retries a transient Jifeng failure while preserving dispatch eligibility", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    let apiCalls = 0;
    let queryCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        apiCalls += 1;
        if (apiCalls === 1) {
          throw new JifengApiError({
            code: "HTTP_503",
            message: "temporary carrier outage",
            retryable: true,
          });
        }
        return { data: null };
      },
      async getOrder() {
        queryCalls += 1;
        throw new JifengApiError({
          code: "50017",
          message: "confirmed absent",
          retryable: false,
        });
      },
    };
    const firstAt = new Date("2026-08-12T02:00:00.000Z");

    await expect(
      processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
        now: firstAt,
      }),
    ).resolves.toEqual({ status: "RETRY_SCHEDULED" });
    await expect(
      processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
        now: new Date(firstAt.getTime() + 60_000),
      }),
    ).resolves.toEqual({ status: "COMPLETED" });

    expect(apiCalls).toBe(2);
    expect(queryCalls).toBe(1);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [savedEvent] = await db.select().from(integrationOutbox);
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    expect(savedOrder.status).toBe("FULFILLING");
    expect(savedEvent).toMatchObject({ attemptCount: 2, status: "COMPLETED" });
    expect(fulfillment).toMatchObject({ attemptCount: 2, status: "SUBMITTED" });
  });

  test("reconciles an ambiguous create response to a remote order without creating twice", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    let apiCalls = 0;
    let queryCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        apiCalls += 1;
        throw new JifengApiError({
          code: "TIMEOUT",
          message: "create outcome unknown",
          retryable: true,
        });
      },
      async getOrder({ erpNo }) {
        queryCalls += 1;
        return { erpNo, orderNo: "JF-REMOTE-1", status: 6 };
      },
    };

    await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    const result = await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });

    expect(result).toEqual({ status: "RECONCILED" });
    expect(apiCalls).toBe(1);
    expect(queryCalls).toBe(1);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [savedEvent] = await db.select().from(integrationOutbox);
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    expect(savedOrder.status).toBe("FULFILLING");
    expect(savedEvent.status).toBe("COMPLETED");
    expect(fulfillment).toMatchObject({
      externalOrderNo: "JF-REMOTE-1",
      status: "SUBMITTED",
    });
  });

  test.each(["50019", "50038"])(
    "automatically reconciles official create code %s instead of blindly creating again",
    async (code) => {
      await createShipmentFixture();
      await enqueuePaidOrdersForFulfillment();
      const [event] = await db.select().from(integrationOutbox);
      let apiCalls = 0;
      let queryCalls = 0;
      const firstAt = new Date("2026-08-12T02:00:00.000Z");
      const client: JifengCreateOrderPort = {
        async createOrder() {
          apiCalls += 1;
          throw new JifengApiError({
            code,
            message: "official reconciliation response",
            retryable: false,
          });
        },
        async getOrder({ erpNo }) {
          queryCalls += 1;
          return { erpNo, orderNo: `JF-${code}`, status: 6 };
        },
      };
      await expect(
        processJifengCreateOrderEvent({
          client,
          config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
          eventId: event.id,
          now: firstAt,
        }),
      ).resolves.toEqual({ status: "RETRY_SCHEDULED" });

      const summary = await processDueJifengCreateOrderEvents({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        now: new Date(firstAt.getTime() + 60_000),
      });

      expect(summary).toEqual({ completed: 1, failed: 0, retryScheduled: 0 });
      expect(apiCalls).toBe(1);
      expect(queryCalls).toBe(1);
    },
  );

  test("manual retry restores dispatch eligibility after a confirmed permanent failure", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    let apiCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        apiCalls += 1;
        if (apiCalls === 1) {
          throw new JifengApiError({
            code: "50024",
            message: "confirmed validation failure",
            retryable: false,
          });
        }
        return { data: null };
      },
    };
    await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });

    await retryJifengShipment({
      actorUserId: "admin-user",
      reason: "corrected warehouse mapping",
      shipmentId: shipment.id,
    });
    await expect(
      processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "COMPLETED" });
    expect(apiCalls).toBe(2);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("FULFILLING");
  });

  test("never retries create after Jifeng success followed by a persistence error", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    let apiCalls = 0;
    let queryCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        apiCalls += 1;
        return { data: null, requestId: "success-before-db-error" };
      },
      async getOrder({ erpNo }) {
        queryCalls += 1;
        return { erpNo, orderNo: "JF-PERSISTED-REMOTE", status: 6 };
      },
    };
    await db.execute(sql.raw(`
      create function test_fail_success_attempt() returns trigger language plpgsql as $$
      begin
        if new.outcome = 'SUCCESS' then
          raise exception 'injected post-success persistence error';
        end if;
        return new;
      end;
      $$;
      create trigger test_fail_success_attempt_trigger
      before insert on integration_attempts
      for each row execute function test_fail_success_attempt();
    `));
    try {
      await expect(
        processJifengCreateOrderEvent({
          client,
          config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
          eventId: event.id,
        }),
      ).resolves.toEqual({ status: "RECONCILIATION_REQUIRED" });
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists test_fail_success_attempt_trigger on integration_attempts;
        drop function if exists test_fail_success_attempt();
      `));
    }

    await expect(
      processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "RECONCILED" });
    expect(apiCalls).toBe(1);
    expect(queryCalls).toBe(1);
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    expect(fulfillment.externalOrderNo).toBe("JF-PERSISTED-REMOTE");
  });

  test("serializes API success finalization with cancellation without duplicate create", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const apiGate = deferred();
    const lockReady = deferred();
    const releaseLock = deferred();
    let apiCalls = 0;
    const dispatch = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          apiCalls += 1;
          await apiGate.promise;
          return { data: null };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    for (let attempt = 0; attempt < 100 && apiCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`
        select id from fulfillment_orders where id = ${order.id} for update
      `);
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;
    const cancellation = cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: "admin-user",
      orderId: order.id,
      reason: "race with successful create",
    });
    apiGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseLock.resolve();

    await blocker;
    await expect(cancellation).rejects.toMatchObject({
      code: "FULFILLMENT_CANCEL_REQUIRED",
    });
    await expect(dispatch).resolves.toEqual({ status: "COMPLETED" });
    expect(apiCalls).toBe(1);
  });
});
