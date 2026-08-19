import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  customers,
  fulfillmentOrders,
  integrationAttempts,
  integrationOutbox,
  jifengConnections,
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
import { encryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import { runJifengFulfillmentCycle } from "@/modules/jifeng-connection/provider";
import {
  enqueuePaidOrdersForFulfillment,
  JIFENG_RECONCILIATION_LEASE_MS,
  processDueJifengCreateOrderEvents,
  processJifengCreateOrderEvent,
  retryJifengShipment,
  type JifengCreateOrderPort,
} from "@/modules/fulfillment/dispatch";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";
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

const providerEncryptionKey = Buffer.alloc(32, 31);

async function insertRuntimeConnection(status: "READY_DISABLED" | "ENABLED") {
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: `Cycle ${status}`,
      loginIdentifier: `cycle-${status.toLowerCase()}@example.test`,
    })
    .returning();
  const now = new Date();
  await db.insert(jifengConnections).values({
    accessTokenEncrypted: encryptJifengSecret(
      "cycle-database-access-token",
      providerEncryptionKey,
    ),
    accessTokenExpiresAt: new Date(now.getTime() + 60 * 60_000),
    authorizedAt: now,
    authorizedByAdminUserId: admin.id,
    connectionKey: "PRIMARY",
    fulfillmentEnabledAt: status === "ENABLED" ? now : null,
    fulfillmentEnabledByAdminUserId: status === "ENABLED" ? admin.id : null,
    logisticsId: 310,
    refreshTokenEncrypted: encryptJifengSecret(
      "cycle-database-refresh-token",
      providerEncryptionKey,
    ),
    refreshTokenExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    status,
    updatedAt: now,
    userId: "cycle-database-user",
    warehouseCode: "CA-YYZ",
  });
  return admin;
}

function configureRuntimeEnvironment() {
  vi.stubEnv("JIFENG_ACCESS_TOKEN", "legacy-access-token");
  vi.stubEnv("JIFENG_BASE_URL", "https://jifeng.example.test");
  vi.stubEnv("JIFENG_CLIENT_ID", "client-id");
  vi.stubEnv("JIFENG_CLIENT_SECRET", "client-secret");
  vi.stubEnv("JIFENG_LEGACY_FULFILLMENT_ENABLED", "true");
  vi.stubEnv("JIFENG_LOGISTICS_ID", "999");
  vi.stubEnv("JIFENG_TOKEN_ENCRYPTION_KEY", providerEncryptionKey.toString("base64url"));
  vi.stubEnv("JIFENG_USER_ID", "legacy-user");
  vi.stubEnv("JIFENG_WAREHOUSE_CODE", "LEGACY-WAREHOUSE");
}

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

async function addSiblingShipment(
  fixture: Awaited<ReturnType<typeof createShipmentFixture>>,
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [shipment] = await db
    .insert(orderShipments)
    .values({
      externalOrderNo: `TEMU-SIBLING-${suffix}`,
      orderId: fixture.order.id,
      recipientPayloadEncrypted: encryptPii(recipient),
      storeId: fixture.store.id,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: `EXT-SIBLING-${suffix}`,
    lineAmountFen: 450,
    orderId: fixture.order.id,
    quantity: 1,
    shipmentId: shipment.id,
    skuCodeSnapshot: fixture.sku.skuCode,
    skuId: fixture.sku.id,
    skuNameSnapshot: fixture.sku.name,
    storeId: fixture.store.id,
    unitPriceFen: 450,
  });
  await db
    .update(fulfillmentOrders)
    .set({
      totalAmountFen: 1_350,
      totalPackageCount: 2,
      totalQuantity: 3,
    })
    .where(eq(fulfillmentOrders.id, fixture.order.id));
  await db
    .update(inventoryReservations)
    .set({ quantity: 3 })
    .where(eq(inventoryReservations.referenceId, fixture.order.id));
  return shipment;
}

describe("paid order Jifeng dispatch", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.execute(sql.raw(`
      truncate table
        jifeng_connections,
        audit_logs,
        integration_attempts,
        integration_outbox,
        shipment_fulfillments,
        order_lines,
        order_shipments,
        fulfillment_orders,
        inventory_reservations,
        inventory_balances,
        admin_users,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("does no write work while disabled and re-reads activation on the next cycle", async () => {
    configureRuntimeEnvironment();
    const { order } = await createShipmentFixture();
    const admin = await insertRuntimeConnection("READY_DISABLED");
    const fetchMock = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      const isOrderQuery = String(url).endsWith("/api/order/get");
      const erpNo = isOrderQuery
        ? String(JSON.parse(String(request?.body)).erpNo)
        : undefined;
      return Response.json({
        code: 0,
        data: isOrderQuery
          ? { erpNo, orderNo: "JF-CYCLE-1", status: 6 }
          : { orderNo: "JF-CYCLE-1" },
        message: "SUCCESS",
        requestId: isOrderQuery ? "cycle-query" : "cycle-create",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runJifengFulfillmentCycle()).resolves.toMatchObject({
      enabled: false,
      enqueuedCount: 0,
    });
    expect(await db.select().from(integrationOutbox)).toHaveLength(0);
    expect(await db.select().from(shipmentFulfillments)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const enabledAt = new Date();
    await db
      .update(jifengConnections)
      .set({
        fulfillmentEnabledAt: enabledAt,
        fulfillmentEnabledByAdminUserId: admin.id,
        status: "ENABLED",
        updatedAt: enabledAt,
      })
      .where(eq(jifengConnections.connectionKey, "PRIMARY"));

    await expect(runJifengFulfillmentCycle()).resolves.toMatchObject({
      enabled: true,
      enqueuedCount: 1,
      processed: { completed: 1, failed: 0, retryScheduled: 0 },
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/order/create"),
      ),
    ).toHaveLength(1);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("FULFILLING");
  });

  test("reconciles ambiguous remote state read-only while disabled and never claims new create work", async () => {
    configureRuntimeEnvironment();
    const existing = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [existingEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, existing.shipment.id));
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "create result was ambiguous",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: existingEvent.id,
      now: new Date(Date.now() - 10 * 60_000),
    });
    const pending = await createShipmentFixture();
    await insertRuntimeConnection("READY_DISABLED");
    const fetchMock = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      const erpNo = String(JSON.parse(String(request?.body)).erpNo);
      return Response.json({
        code: 0,
        data: { erpNo, orderNo: "JF-EXISTING", status: 6 },
        message: "SUCCESS",
        requestId: "disabled-read-query",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runJifengFulfillmentCycle()).resolves.toMatchObject({
      enabled: false,
      enqueuedCount: 0,
      statuses: { exceptions: 0, shipped: 0, synced: 1 },
    });

    const requestedPaths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(requestedPaths).toEqual(["/api/order/get"]);
    expect(requestedPaths).not.toContain("/api/order/create");
    expect(requestedPaths).not.toContain("/api/order/cancel");
    const outboxRows = await db.select().from(integrationOutbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      aggregateId: existing.shipment.id,
      claimToken: null,
      status: "FAILED",
    });
    expect(
      outboxRows.some((row) => row.aggregateId === pending.shipment.id),
    ).toBe(false);
    const [reconciledFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, existing.shipment.id));
    expect(reconciledFulfillment).toMatchObject({
      externalOrderNo: "JF-EXISTING",
      status: "FULFILLING",
    });
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
      packageType: 3,
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

  test("dispatches every package sequentially after the order enters fulfillment", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    expect(await enqueuePaidOrdersForFulfillment()).toBe(2);
    const events = await db.select().from(integrationOutbox);
    const firstEvent = events.find(
      (event) => event.aggregateId === fixture.shipment.id,
    );
    const siblingEvent = events.find((event) => event.aggregateId === sibling.id);
    expect(firstEvent).toBeDefined();
    expect(siblingEvent).toBeDefined();
    const createOrder = vi.fn(async () => ({ data: null }));

    await expect(
      processJifengCreateOrderEvent({
        client: { createOrder },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: firstEvent!.id,
      }),
    ).resolves.toEqual({ status: "COMPLETED" });
    await expect(
      processJifengCreateOrderEvent({
        client: { createOrder },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: siblingEvent!.id,
      }),
    ).resolves.toEqual({ status: "COMPLETED" });

    expect(createOrder).toHaveBeenCalledTimes(2);
    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(fulfillments).toHaveLength(2);
    expect(fulfillments.every((row) => row.status === "SUBMITTED")).toBe(true);
  });

  test("keeps sibling packages dispatchable after one package lacks Jifeng inventory", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    expect(await enqueuePaidOrdersForFulfillment()).toBe(2);
    const events = await db.select().from(integrationOutbox);
    const failedEvent = events.find(
      (event) => event.aggregateId === fixture.shipment.id,
    );
    const siblingEvent = events.find((event) => event.aggregateId === sibling.id);
    expect(failedEvent).toBeDefined();
    expect(siblingEvent).toBeDefined();
    const createOrder = vi.fn(async (input: JifengCreateOrderInput) => {
      if (input.erpNo === `TZX-${fixture.shipment.id.replaceAll("-", "")}`) {
        throw new JifengApiError({
          code: "50026",
          message: "极风仓库对应 SKU 库存不足，请先同步或补充仓库库存",
          retryable: false,
        });
      }
      return { data: null };
    });

    await expect(
      processJifengCreateOrderEvent({
        client: { createOrder },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: failedEvent!.id,
      }),
    ).resolves.toEqual({ status: "FAILED" });
    await expect(
      processJifengCreateOrderEvent({
        client: { createOrder },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: siblingEvent!.id,
      }),
    ).resolves.toEqual({ status: "COMPLETED" });

    expect(createOrder).toHaveBeenCalledTimes(2);
    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(
      fulfillments.find((row) => row.shipmentId === fixture.shipment.id),
    ).toMatchObject({ lastErrorCode: "50026", status: "EXCEPTION" });
    expect(
      fulfillments.find((row) => row.shipmentId === sibling.id),
    ).toMatchObject({ lastErrorCode: null, status: "SUBMITTED" });
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
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
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
            code: "NETWORK_ERROR",
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
      status: "FULFILLING",
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

  test.each([
    ["50019", "50017"],
    ["50019", "50071"],
    ["50038", "50017"],
    ["50038", "50071"],
  ])(
    "keeps prior official code %s query-only when reconciliation returns %s",
    async (priorCode, queryCode) => {
      const { shipment } = await createShipmentFixture();
      await enqueuePaidOrdersForFulfillment();
      const [event] = await db.select().from(integrationOutbox);
      let createCalls = 0;
      let queryCalls = 0;
      const firstAt = new Date("2026-08-12T02:00:00.000Z");
      const client: JifengCreateOrderPort = {
        async createOrder() {
          createCalls += 1;
          throw new JifengApiError({
            code: priorCode,
            message: "official query-only create response",
            retryable: false,
          });
        },
        async getOrder() {
          queryCalls += 1;
          throw new JifengApiError({
            code: queryCode,
            message: "confirmed absent during query-only reconciliation",
            retryable: false,
          });
        },
      };
      await processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
        now: firstAt,
      });
      await processDueJifengCreateOrderEvents({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        now: new Date(firstAt.getTime() + 60_000),
      });
      await retryJifengShipment({
        actorUserId: "admin-user",
        reason: "repeat query-only warehouse investigation",
        shipmentId: shipment.id,
      });
      await processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
        now: new Date(firstAt.getTime() + 120_000),
      });

      expect(createCalls).toBe(1);
      expect(queryCalls).toBe(2);
      const [savedEvent] = await db.select().from(integrationOutbox);
      expect(savedEvent.status).toBe("FAILED");
      expect(savedEvent.lastErrorCode).toContain("RECONCILIATION_REQUIRED");
    },
  );

  test("claims reconciliation atomically so concurrent workers make one remote query and one terminal audit", async () => {
    await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "ambiguous create",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    const queryGate = deferred();
    let successQueries = 0;
    let losingQueries = 0;
    const winner = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new Error("create must not run during reconciliation");
        },
        async getOrder({ erpNo }) {
          successQueries += 1;
          await queryGate.promise;
          return { erpNo, orderNo: "JF-ATOMIC-1", status: 6 };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    for (let index = 0; index < 100 && successQueries === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const loser = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new Error("losing create must not run");
        },
        async getOrder() {
          losingQueries += 1;
          throw new JifengApiError({
            code: "NETWORK_ERROR",
            message: "delayed losing reconciliation",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    queryGate.resolve();

    await expect(winner).resolves.toEqual({ status: "RECONCILED" });
    await expect(loser).resolves.toEqual({ status: "BUSY" });
    expect(successQueries).toBe(1);
    expect(losingQueries).toBe(0);
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    expect(fulfillment).toMatchObject({
      externalOrderNo: "JF-ATOMIC-1",
      jifengStatus: 6,
      status: "FULFILLING",
    });
    const reconciliationAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_ORDER_RECONCILED"));
    expect(reconciliationAudits).toHaveLength(1);
  });

  test("rejects an administrator retry while a live reconciliation claim is querying Jifeng", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    let createCalls = 0;
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "ambiguous create",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const queryGate = deferred();
    let queryCalls = 0;
    const reconciliation = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new Error("create must not run during reconciliation");
        },
        async getOrder({ erpNo }) {
          queryCalls += 1;
          await queryGate.promise;
          return { erpNo, orderNo: "JF-LIVE-CLAIM", status: 6 };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: new Date(firstAt.getTime() + 60_000),
    });
    for (let index = 0; index < 100 && queryCalls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(
      retryJifengShipment({
        actorUserId: "admin-user",
        now: new Date(firstAt.getTime() + 61_000),
        reason: "must not steal a live reconciliation claim",
        shipmentId: shipment.id,
      }),
    ).rejects.toMatchObject({ code: "RECONCILIATION_IN_PROGRESS" });
    queryGate.resolve();

    await expect(reconciliation).resolves.toEqual({ status: "RECONCILED" });
    expect(createCalls).toBe(1);
    expect(queryCalls).toBe(1);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedEvent.status).toBe("COMPLETED");
  });

  test("reclaims a crashed reconciliation exactly at lease expiry and queries Jifeng once", async () => {
    await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    let createCalls = 0;
    let queryCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        createCalls += 1;
        throw new JifengApiError({
          code: "TIMEOUT",
          message: "ambiguous create",
          retryable: true,
        });
      },
      async getOrder({ erpNo }) {
        queryCalls += 1;
        return { erpNo, orderNo: "JF-LEASE-RECOVERED", status: 6 };
      },
    };
    await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const claimAt = new Date(firstAt.getTime() + 60_000);
    const crashedToken = crypto.randomUUID();
    await db.execute(sql`
      update integration_outbox
      set
        claim_token = ${crashedToken}::uuid,
        locked_at = ${claimAt.toISOString()}::timestamptz,
        status = 'PROCESSING'
      where id = ${event.id}
    `);

    const beforeExpiry = await processDueJifengCreateOrderEvents({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      now: new Date(claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS - 1),
    });
    expect(beforeExpiry).toEqual({ completed: 0, failed: 0, retryScheduled: 0 });
    expect(queryCalls).toBe(0);

    const atExpiry = await processDueJifengCreateOrderEvents({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      now: new Date(claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS),
    });
    expect(atExpiry).toEqual({ completed: 1, failed: 0, retryScheduled: 0 });
    expect(createCalls).toBe(1);
    expect(queryCalls).toBe(1);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedEvent).toMatchObject({ claimToken: null, status: "COMPLETED" });
  });

  test("queries before recreating after a stale claim is confirmed absent", async () => {
    await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    const trace: string[] = [];
    let createCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        createCalls += 1;
        trace.push(`create-${createCalls}`);
        if (createCalls === 1) {
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "ambiguous create",
            retryable: true,
          });
        }
        return { data: null };
      },
      async getOrder() {
        trace.push("query");
        throw new JifengApiError({
          code: "50017",
          message: "confirmed absent",
          retryable: false,
        });
      },
    };
    await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const claimAt = new Date(firstAt.getTime() + 60_000);
    await db.execute(sql`
      update integration_outbox
      set
        claim_token = ${crypto.randomUUID()}::uuid,
        last_error_code = null,
        locked_at = ${claimAt.toISOString()}::timestamptz,
        status = 'PROCESSING'
      where id = ${event.id}
    `);

    await expect(
      processDueJifengCreateOrderEvents({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        now: new Date(claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS),
      }),
    ).resolves.toEqual({ completed: 1, failed: 0, retryScheduled: 0 });
    expect(trace).toEqual(["create-1", "query", "create-2"]);
  });

  test("keeps an administrator-recovered stale claim query-only before create", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    let createCalls = 0;
    const claimAt = new Date(firstAt.getTime() + 60_000);
    await db.execute(sql`
      update integration_outbox
      set
        attempt_count = 1,
        claim_token = ${crypto.randomUUID()}::uuid,
        last_error_code = null,
        locked_at = ${claimAt.toISOString()}::timestamptz,
        status = 'PROCESSING'
      where id = ${event.id}
    `);
    await db.execute(sql`
      update shipment_fulfillments
      set attempt_count = 1, last_error_code = null, status = 'EXCEPTION'
      where shipment_id = ${shipment.id}
    `);
    const recoveredAt = new Date(
      claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS,
    );
    await retryJifengShipment({
      actorUserId: "admin-user",
      now: recoveredAt,
      reason: "recover the expired worker lease safely",
      shipmentId: shipment.id,
    });
    let queryCalls = 0;
    await expect(
      processJifengCreateOrderEvent({
        client: {
          async createOrder() {
            createCalls += 1;
            throw new Error("remote exists, create must not repeat");
          },
          async getOrder({ erpNo }) {
            queryCalls += 1;
            return { erpNo, orderNo: "JF-ADMIN-RECOVERED", status: 6 };
          },
        },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
        now: recoveredAt,
      }),
    ).resolves.toEqual({ status: "RECONCILED" });
    expect(createCalls).toBe(0);
    expect(queryCalls).toBe(1);
  });

  test("lets only one concurrent worker reclaim a stale reconciliation lease", async () => {
    await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    let createCalls = 0;
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new JifengApiError({
            code: "NETWORK_ERROR",
            message: "ambiguous create",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const claimAt = new Date(firstAt.getTime() + 60_000);
    await db.execute(sql`
      update integration_outbox
      set
        claim_token = ${crypto.randomUUID()}::uuid,
        locked_at = ${claimAt.toISOString()}::timestamptz,
        status = 'PROCESSING'
      where id = ${event.id}
    `);
    const queryGate = deferred();
    let queryCalls = 0;
    const client: JifengCreateOrderPort = {
      async createOrder() {
        createCalls += 1;
        throw new Error("a stale reconciliation claim must query before create");
      },
      async getOrder({ erpNo }) {
        queryCalls += 1;
        await queryGate.promise;
        return { erpNo, orderNo: "JF-SINGLE-RECLAIMER", status: 6 };
      },
    };
    const now = new Date(claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS);
    const workers = [
      processDueJifengCreateOrderEvents({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        now,
      }),
      processDueJifengCreateOrderEvents({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        now,
      }),
    ];
    for (let index = 0; index < 100 && queryCalls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    queryGate.resolve();
    const summaries = await Promise.all(workers);

    expect(queryCalls).toBe(1);
    expect(createCalls).toBe(1);
    expect(summaries.reduce((sum, item) => sum + item.completed, 0)).toBe(1);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedEvent).toMatchObject({ claimToken: null, status: "COMPLETED" });
  });

  test("prevents an expired reconciliation owner from overwriting the reclaimer result", async () => {
    await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    let createCalls = 0;
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "ambiguous create",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const oldOwnerGate = deferred();
    let oldOwnerQueries = 0;
    const claimAt = new Date(firstAt.getTime() + 60_000);
    const expiredOwner = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new Error("reconciliation must not call create");
        },
        async getOrder() {
          oldOwnerQueries += 1;
          await oldOwnerGate.promise;
          throw new JifengApiError({
            code: "NETWORK_ERROR",
            message: "expired owner failure",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: claimAt,
    });
    for (let index = 0; index < 100 && oldOwnerQueries === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    let newOwnerQueries = 0;
    const reclaimer = await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          createCalls += 1;
          throw new Error("reclaimer must query before create");
        },
        async getOrder({ erpNo }) {
          newOwnerQueries += 1;
          return { erpNo, orderNo: "JF-NEW-LEASE-OWNER", status: 6 };
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: new Date(claimAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS),
    });
    expect(reclaimer).toEqual({ status: "RECONCILED" });
    oldOwnerGate.resolve();
    await expect(expiredOwner).resolves.toEqual({ status: "STALE" });

    expect(createCalls).toBe(1);
    expect(oldOwnerQueries).toBe(1);
    expect(newOwnerQueries).toBe(1);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedEvent).toMatchObject({ claimToken: null, status: "COMPLETED" });
    const reconciliationAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_ORDER_RECONCILED"));
    expect(reconciliationAudits).toHaveLength(1);
  });

  test("does not downgrade a shipment completed by status sync while a reconciliation failure is delayed", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    const firstAt = new Date("2026-08-12T02:00:00.000Z");
    await processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new JifengApiError({
            code: "TIMEOUT",
            message: "ambiguous create",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: firstAt,
    });
    const failureGate = deferred();
    let queryStarted = false;
    const delayedFailure = processJifengCreateOrderEvent({
      client: {
        async createOrder() {
          throw new Error("create must not repeat");
        },
        async getOrder() {
          queryStarted = true;
          await failureGate.promise;
          throw new JifengApiError({
            code: "NETWORK_ERROR",
            message: "delayed status query failure",
            retryable: true,
          });
        },
      },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
      now: new Date(firstAt.getTime() + 60_000),
    });
    for (let index = 0; index < 100 && !queryStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await applyJifengOrderStatus({
      detail: {
        erpNo: fulfillment.erpNo,
        orderNo: "JF-SHIPPED-WHILE-QUERYING",
        status: 7,
        trackingNo: "CP-MONOTONIC",
      },
      now: new Date(firstAt.getTime() + 61_000),
      source: "WEBHOOK",
    });
    failureGate.resolve();

    await expect(delayedFailure).resolves.toEqual({
      status: "ALREADY_COMPLETED",
    });
    const [savedFulfillment] = await db.select().from(shipmentFulfillments);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    expect(savedFulfillment.status).toBe("SHIPPED");
    expect(savedOrder.status).toBe("SHIPPED");
    expect(savedEvent.status).toBe("COMPLETED");
    expect(
      (await db.select().from(auditLogs)).filter(
        (audit) => audit.action === "JIFENG_ORDER_RECONCILIATION_REQUIRED",
      ),
    ).toHaveLength(0);
  });

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
