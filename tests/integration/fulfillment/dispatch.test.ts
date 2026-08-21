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
  systemNotifications,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import { encryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import { runJifengFulfillmentCycle } from "@/modules/jifeng-connection/provider";
import {
  enqueuePaidOrdersForFulfillment,
  retryJifengShipment,
} from "@/modules/fulfillment/dispatch";
import { processJifengExistingOrderMatchEvent } from "@/modules/fulfillment/order-matching";
import { cancelJifengShipment } from "@/modules/fulfillment/replacement";
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
      totalAmountFen: 2_200,
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
      totalAmountFen: 3_950,
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
      const platformOrderNo = isOrderQuery
        ? String(JSON.parse(String(request?.body)).platformOrderNo)
        : undefined;
      return Response.json({
        code: 0,
        data: isOrderQuery
          ? {
              erpNo: "JF-ERP-CYCLE-1",
              orderNo: "JF-CYCLE-1",
              platformOrderNo,
              status: 2,
            }
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
    ).toHaveLength(0);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("FULFILLING");
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

  test("matches by the package order number and binds a different remote ERP number without create", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const localErpNo = `TZX-${shipment.id.replaceAll("-", "")}`;
    const remoteErpNo = `JF-ERP-${crypto.randomUUID().slice(0, 8)}`;

    const getOrder = vi.fn<
      (input: { platformOrderNo: string }) => Promise<{
        erpNo: string;
        orderNo: string;
        platformOrderNo: string;
        status: number;
      }>
    >(async () => ({
      erpNo: remoteErpNo,
      orderNo: "JF-ORDER-EXISTING",
      platformOrderNo: shipment.externalOrderNo,
      status: 2,
    }));
    const result = await processJifengExistingOrderMatchEvent({
      client: { getOrder },
      eventId: event.id,
      now: new Date("2026-08-12T02:05:00.000Z"),
    });

    expect(result).toEqual({ status: "MATCHED" });
    const [[queryInput]] = getOrder.mock.calls;
    expect(queryInput).toEqual({ platformOrderNo: shipment.externalOrderNo });

    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));

    expect(savedFulfillment).toMatchObject({
      externalOrderNo: "JF-ORDER-EXISTING",
      erpNo: remoteErpNo,
      jifengStatus: 2,
      status: "FULFILLING",
    });
    expect(savedFulfillment.erpNo).not.toBe(localErpNo);
    expect(savedOrder.status).toBe("FULFILLING");
    expect(savedEvent.status).toBe("COMPLETED");
  });

  test("keeps a missing existing order pending with backoff instead of creating or raising a warehouse exception", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);

    const getOrder = vi.fn<
      (input: { platformOrderNo: string }) => Promise<never>
    >(async () => {
      throw new JifengApiError({
        code: "50017",
        message: "not found",
        retryable: false,
      });
    });
    const now = new Date("2026-08-12T02:05:00.000Z");
    const result = await processJifengExistingOrderMatchEvent({
      client: { getOrder },
      eventId: event.id,
      now,
    });

    expect(result).toEqual({ status: "RETRY_SCHEDULED" });
    const [[queryInput]] = getOrder.mock.calls;
    expect(queryInput).toEqual({ platformOrderNo: shipment.externalOrderNo });
    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    expect(savedFulfillment).toMatchObject({
      erpNo: `TZX-${shipment.id.replaceAll("-", "")}`,
      lastErrorCode: "50017",
      status: "PENDING",
    });
    expect(savedFulfillment.nextRetryAt?.getTime()).toBeGreaterThan(now.getTime());
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    expect(savedEvent.status).toBe("FAILED");
    const [updatedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(updatedOrder.status).toBe("PAID_PENDING_FULFILLMENT");

    await expect(
      cancelJifengShipment({
        actorUserId: crypto.randomUUID(),
        reason: "极风尚未匹配，直接取消本地包裹",
        shipmentId: shipment.id,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });
  });

  test("notifies only when missing-order matching first reaches the warning threshold and resolves it after a match", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const warningKey = `jifeng-match:${(
      await db.select().from(shipmentFulfillments)
    )[0]!.id}:waiting`;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(
        processJifengExistingOrderMatchEvent({
          client: {
            async getOrder() {
              throw new JifengApiError({
                code: attempt % 2 === 0 ? "50071" : "50017",
                message: "existing order not found",
                retryable: false,
              });
            },
          },
          eventId: event.id,
          now: new Date(`2026-08-12T${String(attempt).padStart(2, "0")}:05:00.000Z`),
        }),
      ).resolves.toEqual({ status: "RETRY_SCHEDULED" });
    }

    const [warning] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.deduplicationKey, warningKey));
    const warningDeliveries = (await db.select().from(integrationOutbox)).filter(
      (outbox) =>
        outbox.target === "FEISHU_BOT" &&
        outbox.aggregateId === warning?.id,
    );
    expect(warning).toMatchObject({ occurrenceCount: 1, status: "UNREAD" });
    expect(warningDeliveries).toHaveLength(1);

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-AFTER-WAITING",
              orderNo: "JF-AFTER-WAITING",
              platformOrderNo: shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: event.id,
        now: new Date("2026-08-12T09:05:00.000Z"),
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const [resolvedWarning] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.deduplicationKey, warningKey));
    expect(resolvedWarning).toMatchObject({
      occurrenceCount: 1,
      resolvedAt: expect.any(Date),
      status: "RESOLVED",
    });
  });

  test("resolves the permanent match notification after an operator retry succeeds", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const [fulfillment] = await db.select().from(shipmentFulfillments);
    const notificationKey = `jifeng-match:${fulfillment!.id}:PLATFORM_ORDER_NO_MISMATCH`;

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-WRONG-ORDER-RETRY",
              orderNo: "JF-WRONG-ORDER-RETRY",
              platformOrderNo: `${shipment.externalOrderNo}-OTHER`,
              status: 2,
            };
          },
        },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "FAILED" });
    const [openNotification] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.deduplicationKey, notificationKey));
    expect(openNotification).toMatchObject({ status: "UNREAD" });

    await retryJifengShipment({
      actorUserId: crypto.randomUUID(),
      reason: "人工核对后重新匹配",
      shipmentId: shipment.id,
    });
    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-AFTER-MANUAL-RETRY",
              orderNo: "JF-AFTER-MANUAL-RETRY",
              platformOrderNo: shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const [resolvedNotification] = await db
      .select()
      .from(systemNotifications)
      .where(eq(systemNotifications.deduplicationKey, notificationKey));
    expect(resolvedNotification).toMatchObject({
      resolvedAt: expect.any(Date),
      status: "RESOLVED",
    });
  });

  test("rejects a Jifeng response whose platform order number does not exactly match the package", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-WRONG-ORDER",
              orderNo: "JF-WRONG-ORDER",
              platformOrderNo: `${shipment.externalOrderNo}-OTHER`,
              status: 2,
            };
          },
        },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "FAILED" });

    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedFulfillment).toMatchObject({
      externalOrderNo: null,
      lastErrorCode: "PLATFORM_ORDER_NO_MISMATCH",
      status: "EXCEPTION",
    });
    expect(savedFulfillment.erpNo).toBe(`TZX-${shipment.id.replaceAll("-", "")}`);
    expect(savedOrder.status).toBe("FULFILLMENT_EXCEPTION");
  });

  test("allows cancelling the whole local order after lookup attempts when no Jifeng order was bound", async () => {
    const { order } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          throw new JifengApiError({
            code: "50017",
            message: "not found",
            retryable: false,
          });
        },
      },
      eventId: event.id,
    });

    await expect(
      cancelFulfillmentOrder({
        actorType: "ADMIN",
        actorUserId: crypto.randomUUID(),
        orderId: order.id,
        reason: "极风未匹配，取消整个本地拿货单",
      }),
    ).resolves.toEqual({ orderId: order.id, status: "CANCELLED" });

    const [savedFulfillment] = await db.select().from(shipmentFulfillments);
    const [savedEvent] = await db.select().from(integrationOutbox);
    expect(savedFulfillment).toMatchObject({
      cancelledAt: expect.any(Date),
      status: "CANCELLED",
    });
    expect(savedEvent).toMatchObject({
      lastErrorCode: "LOCAL_CANCEL_MONITORING",
      status: "PENDING",
    });
  });

  test("does not call Jifeng when platform order number is not globally unique among active shipments", async () => {
    const first = await createShipmentFixture();
    const second = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    await db
      .update(orderShipments)
      .set({ externalOrderNo: first.shipment.externalOrderNo })
      .where(eq(orderShipments.id, second.shipment.id));

    const [firstEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, first.shipment.id));
    const getOrder = vi.fn(async () => {
      throw new Error("should not call remote when duplicate platform no");
    });

    await expect(
      processJifengExistingOrderMatchEvent({
        client: { getOrder },
        eventId: firstEvent.id,
      }),
    ).resolves.toEqual({ status: "FAILED" });
    expect(getOrder).not.toHaveBeenCalled();

    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, first.shipment.id));
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, firstEvent.id));

    expect(savedFulfillment).toMatchObject({
      lastErrorCode: "PLATFORM_ORDER_NO_NOT_GLOBAL_UNIQUE",
      status: "EXCEPTION",
      erpNo: `TZX-${first.shipment.id.replaceAll("-", "")}`,
    });
    expect(savedEvent).toMatchObject({
      aggregateId: first.shipment.id,
      lastErrorCode: "PLATFORM_ORDER_NO_NOT_GLOBAL_UNIQUE",
      status: "FAILED",
    });
  });

  test("stores remote identity on shipped status when inventory invariants fail and does not retry", async () => {
    const { order, shipment, sku } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const remoteErpNo = `REMOTE-ERP-${crypto.randomUUID().slice(0, 8)}`;

    await db
      .update(inventoryBalances)
      .set({ totalQuantity: 0 })
      .where(eq(inventoryBalances.skuId, sku.id));

    const result = await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          return {
            currency: "CAD",
            erpNo: remoteErpNo,
            orderNo: "JF-INVARIANT-MISMATCH",
            platformOrderNo: shipment.externalOrderNo,
            status: 7,
            trackingNo: "CP-INVARIANT",
          };
        },
      },
      eventId: event.id,
    });

    expect(result).toEqual({ status: "FAILED" });

    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    const [attempt] = await db
      .select()
      .from(integrationAttempts)
      .where(eq(integrationAttempts.outboxEventId, event.id));

    expect(savedFulfillment).toMatchObject({
      erpNo: remoteErpNo,
      externalOrderNo: "JF-INVARIANT-MISMATCH",
      jifengStatus: 7,
      lastErrorCode: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
      status: "EXCEPTION",
    });
    expect(savedEvent).toMatchObject({
      lastErrorCode: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
      status: "FAILED",
    });
    expect(savedEvent.nextAttemptAt?.toISOString()).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    expect(attempt).toMatchObject({
      errorCode: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
      outcome: "PERMANENT_FAILURE",
      responseMetadata: {
        platformOrderNo: shipment.externalOrderNo,
        remoteErpNo,
        remoteOrderNo: "JF-INVARIANT-MISMATCH",
        remoteStatus: 7,
      },
    });
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("FULFILLMENT_EXCEPTION");
  });

  test("continues monitoring in CANCELLED mode and still completes monitoring when remote order appears", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          throw new JifengApiError({
            code: "50017",
            message: "not found",
            retryable: false,
          });
        },
      },
      eventId: event.id,
    });
    await cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: crypto.randomUUID(),
      orderId: order.id,
      reason: "先取消再等待极风订单后续回传",
    });
    const stillMissing = await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          throw new JifengApiError({
            code: "50017",
            message: "still not found after local cancellation",
            retryable: false,
          });
        },
      },
      eventId: event.id,
    });
    expect(stillMissing).toEqual({ status: "RETRY_SCHEDULED" });
    const [monitoringEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    expect(monitoringEvent).toMatchObject({
      lastErrorCode: "LOCAL_CANCEL_MONITORING",
      status: "FAILED",
    });
    const remoteErpNo = `REMOTE-ERP-${crypto.randomUUID().slice(0, 8)}`;
    const result = await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          return {
            erpNo: remoteErpNo,
            orderNo: "JF-REMOTE-ARRIVED",
            platformOrderNo: shipment.externalOrderNo,
            status: 2,
            trackingNo: "CP-LATE",
          };
        },
      },
      eventId: event.id,
    });

    expect(result).toEqual({ status: "MATCHED" });
    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    const cancelConflictNotification = (
      await db.select().from(systemNotifications)
    ).find(
      (notification) =>
        notification.entityId === shipment.id &&
        notification.title === "本地取消与极风订单不一致",
    );
    expect(savedFulfillment).toMatchObject({
      erpNo: remoteErpNo,
      externalOrderNo: "JF-REMOTE-ARRIVED",
      status: "CANCELLED",
    });
    expect(savedEvent).toMatchObject({ status: "COMPLETED" });
    expect(cancelConflictNotification).not.toBeUndefined();
    expect(savedEvent.lastErrorCode).toBeNull();
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("CANCELLED");
  });

  test("lets a cancelled monitoring shipment yield to a re-imported active shipment with the same platform order number", async () => {
    const first = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [firstEvent] = await db.select().from(integrationOutbox);
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          throw new JifengApiError({
            code: "50017",
            message: "not found",
            retryable: false,
          });
        },
      },
      eventId: firstEvent.id,
    });
    await cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: crypto.randomUUID(),
      orderId: first.order.id,
      reason: "取消后准备重新导入同一个平台订单",
    });

    const second = await createShipmentFixture();
    await db
      .update(orderShipments)
      .set({ externalOrderNo: first.shipment.externalOrderNo })
      .where(eq(orderShipments.id, second.shipment.id));
    await enqueuePaidOrdersForFulfillment();
    const secondEvent = (
      await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.aggregateId, second.shipment.id))
    )[0];
    expect(secondEvent).toBeDefined();

    const getOrder = vi.fn(async () => ({
      erpNo: "REMOTE-ERP-REIMPORT",
      orderNo: "JF-REIMPORT",
      platformOrderNo: first.shipment.externalOrderNo,
      status: 2,
    }));

    await expect(
      processJifengExistingOrderMatchEvent({
        client: { getOrder },
        eventId: firstEvent.id,
      }),
    ).resolves.toEqual({ status: "SKIPPED_CANCELLED" });
    expect(getOrder).not.toHaveBeenCalled();

    await expect(
      processJifengExistingOrderMatchEvent({
        client: { getOrder },
        eventId: secondEvent!.id,
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const firstFulfillment = (
      await db
        .select()
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.shipmentId, first.shipment.id))
    )[0];
    const secondFulfillment = (
      await db
        .select()
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.shipmentId, second.shipment.id))
    )[0];
    const updatedFirstEvent = (
      await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.id, firstEvent.id))
    )[0];

    expect(firstFulfillment).toMatchObject({ status: "CANCELLED" });
    expect(secondFulfillment).toMatchObject({
      erpNo: "REMOTE-ERP-REIMPORT",
      externalOrderNo: "JF-REIMPORT",
      status: "FULFILLING",
    });
    expect(updatedFirstEvent).toMatchObject({
      lastErrorCode: "LOCAL_CANCEL_MONITORING",
      status: "COMPLETED",
    });
  });

  test("prevents two system packages from binding the same Jifeng ERP order", async () => {
    const first = await createShipmentFixture();
    const second = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const events = await db.select().from(integrationOutbox);
    const firstEvent = events.find(
      (event) => event.aggregateId === first.shipment.id,
    );
    const secondEvent = events.find(
      (event) => event.aggregateId === second.shipment.id,
    );
    expect(firstEvent).toBeDefined();
    expect(secondEvent).toBeDefined();
    const remoteErpNo = "REMOTE-ERP-ONE-TIME-BINDING";

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: remoteErpNo,
              orderNo: "JF-FIRST-BINDING",
              platformOrderNo: first.shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: firstEvent!.id,
      }),
    ).resolves.toEqual({ status: "MATCHED" });
    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: remoteErpNo,
              orderNo: "JF-DUPLICATE-BINDING",
              platformOrderNo: second.shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: secondEvent!.id,
      }),
    ).resolves.toEqual({ status: "FAILED" });

    const saved = await db
      .select()
      .from(shipmentFulfillments)
      .orderBy(shipmentFulfillments.shipmentId);
    expect(saved.filter((row) => row.erpNo === remoteErpNo)).toHaveLength(1);
    expect(saved.find((row) => row.shipmentId === second.shipment.id)).toMatchObject({
      lastErrorCode: "REMOTE_ORDER_ALREADY_BOUND",
      status: "EXCEPTION",
    });
  });

  test("leases one match event so concurrent workers perform only one Jifeng lookup", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    const getOrder = vi.fn(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return {
        erpNo: "REMOTE-ERP-CONCURRENT",
        orderNo: "JF-CONCURRENT",
        platformOrderNo: shipment.externalOrderNo,
        status: 2,
      };
    });

    const first = processJifengExistingOrderMatchEvent({
      client: { getOrder },
      eventId: event.id,
    });
    await lookupStarted.promise;
    await expect(
      processJifengExistingOrderMatchEvent({
        client: { getOrder },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "BUSY" });
    releaseLookup.resolve();
    await expect(first).resolves.toEqual({ status: "MATCHED" });
    expect(getOrder).toHaveBeenCalledTimes(1);
  });

  test("reclaims a processing match whose lease timestamp is missing", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await db
      .update(integrationOutbox)
      .set({
        claimToken: "00000000-0000-4000-8000-000000000001",
        lockedAt: null,
        status: "PROCESSING",
      })
      .where(eq(integrationOutbox.id, event.id));

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-ORPHANED-CLAIM",
              orderNo: "JF-ORPHANED-CLAIM",
              platformOrderNo: shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: event.id,
      }),
    ).resolves.toEqual({ status: "MATCHED" });
  });

  test("records the abandoned attempt before reclaiming an expired processing match", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const staleStartedAt = new Date("2026-08-12T01:00:00.000Z");
    const recoveredAt = new Date("2026-08-12T01:06:00.000Z");
    await db
      .update(integrationOutbox)
      .set({
        attemptCount: 1,
        claimToken: "00000000-0000-4000-8000-000000000002",
        lockedAt: staleStartedAt,
        status: "PROCESSING",
      })
      .where(eq(integrationOutbox.id, event.id));
    await db
      .update(shipmentFulfillments)
      .set({
        attemptCount: 1,
        lastAttemptAt: staleStartedAt,
        status: "SUBMITTING",
      })
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-STALE-RECOVERY",
              orderNo: "JF-STALE-RECOVERY",
              platformOrderNo: shipment.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: event.id,
        now: recoveredAt,
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const attempts = await db
      .select()
      .from(integrationAttempts)
      .where(eq(integrationAttempts.outboxEventId, event.id))
      .orderBy(integrationAttempts.attemptNumber);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attemptNumber: 1,
      errorCode: "STALE_PROCESSING",
      outcome: "RETRYABLE_FAILURE",
      startedAt: staleStartedAt,
    });
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      outcome: "SUCCESS",
    });
  });

  test("immediately applies shipped status, tracking, and inventory deduction when the matched order already shipped", async () => {
    const { order, shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    const shippedAt = new Date("2026-08-12T03:05:00.000Z");

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              currency: "CAD",
              erpNo: "REMOTE-ERP-ALREADY-SHIPPED",
              logisticsFee: 12.34,
              orderNo: "JF-ALREADY-SHIPPED",
              platformOrderNo: shipment.externalOrderNo,
              shippedTime: shippedAt.toISOString(),
              status: 7,
              trackingNo: "CP-ALREADY-SHIPPED",
            };
          },
        },
        eventId: event.id,
        now: shippedAt,
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const [savedShipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.id, shipment.id));
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    const [balance] = await db.select().from(inventoryBalances);
    expect(savedFulfillment.status).toBe("SHIPPED");
    expect(savedShipment).toMatchObject({
      logisticsCurrency: "CAD",
      logisticsFeeMinor: 1234,
      trackingNumber: "CP-ALREADY-SHIPPED",
    });
    expect(savedOrder.status).toBe("SHIPPED");
    expect(balance.totalQuantity).toBe(18);
  });

  test("matches every package independently after the order enters fulfillment", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    expect(await enqueuePaidOrdersForFulfillment()).toBe(2);
    const events = await db.select().from(integrationOutbox);
    const getOrder = vi.fn(async ({ platformOrderNo }: { platformOrderNo: string }) => ({
      erpNo: `REMOTE-${platformOrderNo}`,
      orderNo: `JF-${platformOrderNo}`,
      platformOrderNo,
      status: 2,
    }));

    for (const event of events) {
      await expect(
        processJifengExistingOrderMatchEvent({
          client: { getOrder },
          eventId: event.id,
        }),
      ).resolves.toEqual({ status: "MATCHED" });
    }

    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(getOrder.mock.calls.map(([input]) => input.platformOrderNo).sort()).toEqual(
      [fixture.shipment.externalOrderNo, sibling.externalOrderNo].sort(),
    );
    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(fulfillments).toHaveLength(2);
    expect(fulfillments.every((row) => row.status === "FULFILLING")).toBe(true);
  });

  test("keeps a missing sibling pending while another package matches", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    expect(await enqueuePaidOrdersForFulfillment()).toBe(2);
    const events = await db.select().from(integrationOutbox);
    const missingEvent = events.find(
      (event) => event.aggregateId === fixture.shipment.id,
    );
    const siblingEvent = events.find((event) => event.aggregateId === sibling.id);
    expect(missingEvent).toBeDefined();
    expect(siblingEvent).toBeDefined();

    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            throw new JifengApiError({
              code: "50017",
              message: "existing order not found",
              retryable: false,
            });
          },
        },
        eventId: missingEvent!.id,
      }),
    ).resolves.toEqual({ status: "RETRY_SCHEDULED" });
    await expect(
      processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: "REMOTE-ERP-SIBLING",
              orderNo: "JF-SIBLING",
              platformOrderNo: sibling.externalOrderNo,
              status: 2,
            };
          },
        },
        eventId: siblingEvent!.id,
      }),
    ).resolves.toEqual({ status: "MATCHED" });

    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(
      fulfillments.find((row) => row.shipmentId === fixture.shipment.id),
    ).toMatchObject({ lastErrorCode: "50017", status: "PENDING" });
    expect(
      fulfillments.find((row) => row.shipmentId === sibling.id),
    ).toMatchObject({
      erpNo: "REMOTE-ERP-SIBLING",
      externalOrderNo: "JF-SIBLING",
      status: "FULFILLING",
    });
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    expect(savedOrder.status).toBe("FULFILLING");
  });

  test("cancels one unmatched package locally while keeping its sibling matchable", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    await enqueuePaidOrdersForFulfillment();
    let remoteCancellationCalls = 0;

    await cancelJifengShipment({
      actorUserId: "admin-user",
      client: {
        async cancelOrder() {
          remoteCancellationCalls += 1;
          throw new Error("unmatched package must not call Jifeng cancellation");
        },
      },
      reason: "客户只取消其中一个平台订单",
      shipmentId: fixture.shipment.id,
    });

    expect(remoteCancellationCalls).toBe(0);
    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(
      fulfillments.find((row) => row.shipmentId === fixture.shipment.id),
    ).toMatchObject({ status: "CANCELLED" });
    expect(
      fulfillments.find((row) => row.shipmentId === sibling.id),
    ).toMatchObject({ status: "PENDING" });
    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, fixture.order.id));
    expect(reservation.quantity).toBe(1);
    const events = await db.select().from(integrationOutbox);
    expect(
      events.find((event) => event.aggregateId === fixture.shipment.id),
    ).toMatchObject({
      lastErrorCode: "LOCAL_CANCEL_MONITORING",
      status: "PENDING",
    });
    expect(
      events.find((event) => event.aggregateId === sibling.id),
    ).toMatchObject({ status: "PENDING" });
  });

  test("retrying one unmatched exception keeps the parent exceptional while a sibling remains failed", async () => {
    const fixture = await createShipmentFixture();
    const sibling = await addSiblingShipment(fixture);
    await enqueuePaidOrdersForFulfillment();
    const events = await db.select().from(integrationOutbox);

    for (const event of events) {
      const platformOrderNo =
        event.aggregateId === fixture.shipment.id
          ? fixture.shipment.externalOrderNo
          : sibling.externalOrderNo;
      await processJifengExistingOrderMatchEvent({
        client: {
          async getOrder() {
            return {
              erpNo: `REMOTE-${event.aggregateId}`,
              orderNo: `JF-${event.aggregateId}`,
              platformOrderNo: `${platformOrderNo}-WRONG`,
              status: 2,
            };
          },
        },
        eventId: event.id,
      });
    }

    await expect(
      retryJifengShipment({
        actorUserId: "admin-user",
        reason: "修正平台订单号后重新匹配",
        shipmentId: fixture.shipment.id,
      }),
    ).resolves.toEqual({ status: "PENDING" });

    const fulfillments = await db.select().from(shipmentFulfillments);
    expect(
      fulfillments.find((row) => row.shipmentId === fixture.shipment.id),
    ).toMatchObject({ lastErrorCode: null, status: "PENDING" });
    expect(
      fulfillments.find((row) => row.shipmentId === sibling.id),
    ).toMatchObject({
      lastErrorCode: "PLATFORM_ORDER_NO_MISMATCH",
      status: "EXCEPTION",
    });
    const retriedEvent = events.find(
      (event) => event.aggregateId === fixture.shipment.id,
    )!;
    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, retriedEvent.id));
    expect(savedEvent).toMatchObject({
      claimToken: null,
      lastErrorCode: null,
      status: "PENDING",
    });
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    expect(savedOrder.status).toBe("FULFILLMENT_EXCEPTION");
  });

  test("manual recovery of a matched warehouse exception schedules only a status query", async () => {
    const { shipment } = await createShipmentFixture();
    await enqueuePaidOrdersForFulfillment();
    const [event] = await db.select().from(integrationOutbox);
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder() {
          return {
            erpNo: "REMOTE-ERP-STATUS-RECOVERY",
            orderNo: "JF-STATUS-RECOVERY",
            platformOrderNo: shipment.externalOrderNo,
            status: 2,
          };
        },
      },
      eventId: event.id,
    });
    await db
      .update(shipmentFulfillments)
      .set({
        jifengStatus: 8,
        lastErrorCode: "50038",
        lastErrorMessage: "warehouse exception",
        status: "EXCEPTION",
      })
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    const retryAt = new Date();

    await expect(
      retryJifengShipment({
        actorUserId: "admin-user",
        now: retryAt,
        reason: "仓库异常已处理，立即重新查询",
        shipmentId: shipment.id,
      }),
    ).resolves.toEqual({ status: "STATUS_REFRESH_SCHEDULED" });

    const [savedEvent] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, event.id));
    expect(savedEvent).toMatchObject({ status: "COMPLETED" });
    const [savedFulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, shipment.id));
    expect(savedFulfillment).toMatchObject({
      erpNo: "REMOTE-ERP-STATUS-RECOVERY",
      externalOrderNo: "JF-STATUS-RECOVERY",
      jifengStatus: 8,
      lastErrorCode: null,
      nextRetryAt: retryAt,
      status: "EXCEPTION",
    });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_SHIPMENT_RETRY_REQUESTED"));
    expect(audit.afterJson).toMatchObject({ recoveryMode: "STATUS_QUERY" });
  });
});
