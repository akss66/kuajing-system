import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: vi.fn(async () => ({
    kind: "ADMIN",
    userId: "auth-admin-replacement",
  })),
}));

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  customers,
  fulfillmentOrders,
  integrationOutbox,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  jifengConnections,
  orderLines,
  orderShipments,
  products,
  replacementRequests,
  settlementBatchOrders,
  settlementBatches,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import { cancelJifengShipmentAction } from "@/modules/fulfillment/actions";
import { processJifengExistingOrderMatchEvent } from "@/modules/fulfillment/order-matching";
import {
  cancelJifengShipment,
  createReplacementRequest,
  ReplacementError,
} from "@/modules/fulfillment/replacement";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";
import { encryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import { encryptPii } from "@/shared/pii-crypto";

const actionEncryptionKey = Buffer.alloc(32, 37);

async function createShippedFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: "补发管理员",
      loginIdentifier: `replacement-${suffix}@example.com`,
    })
    .returning();
  const [customer] = await db
    .insert(customers)
    .values({ code: `R-${suffix}`, name: "补发客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `补发店铺-${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `补发商品-${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 450,
      name: "头绳 黑色",
      productId: product.id,
      skuCode: `TZX-R-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-REPL-${suffix}`,
      paidAt: new Date(),
      paymentMode: "DIRECT_OFFLINE",
      status: "SHIPPED",
      storeId: store.id,
      totalAmountFen: 900,
      totalPackageCount: 1,
      totalQuantity: 2,
    })
    .returning();
  const [shipment] = await db
    .insert(orderShipments)
    .values({
      externalOrderNo: `TEMU-REPL-${suffix}`,
      orderId: order.id,
      recipientPayloadEncrypted: encryptPii({
        addressLine1: "400 Example Street",
        addressLine2: null,
        addressLine3: null,
        alternatePhone: null,
        city: "Ottawa",
        country: "Canada",
        district: null,
        email: null,
        identityNumber: null,
        name: "Replacement Recipient",
        phone: "+1 613 555 0120",
        postalCode: "K1A 0B1",
        province: "Ontario",
        taxNumber: null,
      }),
      shippedAt: new Date(),
      storeId: store.id,
      trackingNumber: `CP-${suffix}`,
    })
    .returning();
  await db.insert(orderLines).values({
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
  await db.insert(shipmentFulfillments).values({
    erpNo: `TZX-ORIGINAL-${suffix}`,
    jifengStatus: 7,
    shipmentId: shipment.id,
    shippedAt: new Date(),
    status: "SHIPPED",
  });
  return { admin, customer, order, shipment, sku, store };
}

describe("replacement fulfillment", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await db.execute(sql.raw(`
      truncate table
        jifeng_connections,
        audit_logs,
        integration_attempts,
        integration_outbox,
        replacement_requests,
        shipment_fulfillments,
        inventory_movements,
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

  test("atomically reserves stock, creates a zero-charge replacement package and deducts only after Jifeng ships", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "运输途中破损，补发 1 件",
    });

    const [replacement] = await db
      .select()
      .from(replacementRequests)
      .where(eq(replacementRequests.id, created.replacementRequestId));
    const [replacementShipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.id, created.replacementShipmentId));
    const [replacementLine] = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.shipmentId, created.replacementShipmentId));
    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, replacement.id));
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, replacementShipment.id));
    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, replacementShipment.id));
    expect(replacement).toMatchObject({
      originalShipmentId: fixture.shipment.id,
      reason: "运输途中破损，补发 1 件",
      status: "PENDING_FULFILLMENT",
    });
    expect(replacementShipment).toMatchObject({
      kind: "REPLACEMENT",
      orderId: fixture.order.id,
      recipientPayloadEncrypted: fixture.shipment.recipientPayloadEncrypted,
      shippingFeeFen: 0,
    });
    expect(replacementLine).toMatchObject({
      lineAmountFen: 0,
      quantity: 1,
      skuId: fixture.sku.id,
      unitPriceFen: 0,
    });
    expect(reservation).toMatchObject({
      quantity: 1,
      referenceType: "REPLACEMENT_REQUEST",
      status: "ACTIVE",
    });
    expect(fulfillment.status).toBe("PENDING");
    expect(event).toMatchObject({ eventType: "JIFENG_CREATE_ORDER", status: "PENDING" });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(10);

    const replacementErpNo = `JF-ERP-${created.replacementRequestId}`;
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder({ platformOrderNo }) {
          expect(platformOrderNo).toBe(replacementShipment.externalOrderNo);
          return {
            erpNo: replacementErpNo,
            orderNo: "JF-REPLACEMENT-1",
            platformOrderNo,
            status: 2,
          };
        },
      },
      eventId: event.id,
    });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(10);

    await applyJifengOrderStatus({
      detail: {
        currency: "CAD",
        erpNo: replacementErpNo,
        logisticsFee: 7.5,
        status: 7,
        trackingNo: "CP-REPLACEMENT-1",
      },
      source: "POLL",
    });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(9);
    expect((await db.select().from(inventoryMovements))).toHaveLength(1);
    expect((await db.select().from(inventoryReservations))[0].status).toBe("CONSUMED");
    expect((await db.select().from(replacementRequests))[0].status).toBe("SHIPPED");
    expect((await db.select().from(fulfillmentOrders))[0].status).toBe("SHIPPED");
  });

  test("rejects replacement quantities outside the shipped original package", async () => {
    const fixture = await createShippedFixture();
    await expect(
      createReplacementRequest({
        actorUserId: "auth-admin-replacement",
        adminUserId: fixture.admin.id,
        items: [{ quantity: 3, skuId: fixture.sku.id }],
        originalShipmentId: fixture.shipment.id,
        reason: "数量超过原包裹",
      }),
    ).rejects.toBeInstanceOf(ReplacementError);
    expect(await db.select().from(replacementRequests)).toHaveLength(0);
    expect(await db.select().from(inventoryReservations)).toHaveLength(0);
  });

  test("releases replacement stock only after Jifeng confirms cancellation", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "测试取消补发",
    });
    const [replacementShipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.id, created.replacementShipmentId));
    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, created.replacementShipmentId));
    const replacementErpNo = `JF-ERP-${created.replacementRequestId}`;
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder({ platformOrderNo }) {
          expect(platformOrderNo).toBe(replacementShipment.externalOrderNo);
          return {
            erpNo: replacementErpNo,
            orderNo: "JF-REPLACEMENT-BEFORE-CANCEL",
            platformOrderNo,
            status: 2,
          };
        },
      },
      eventId: event.id,
    });

    await expect(
      cancelJifengShipment({
        actorUserId: "auth-admin-replacement",
        client: {
          async cancelOrder() {
            throw new JifengApiError({
              code: "HTTP_503",
              message: "极风接口网络响应异常（503）",
              retryable: true,
            });
          },
        },
        reason: "地址需要更正",
        shipmentId: created.replacementShipmentId,
      }),
    ).rejects.toBeInstanceOf(JifengApiError);
    expect((await db.select().from(inventoryReservations))[0].status).toBe("ACTIVE");
    expect((await db.select().from(shipmentFulfillments))[1]).toMatchObject({
      lastErrorCode: "HTTP_503",
      status: "EXCEPTION",
    });

    await cancelJifengShipment({
      actorUserId: "auth-admin-replacement",
      client: {
        async cancelOrder(input) {
          expect(input).toEqual({ deleteRecord: false, erpNo: replacementErpNo });
          return { data: null, requestId: "cancel-success" };
        },
      },
      reason: "地址需要更正",
      shipmentId: created.replacementShipmentId,
    });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      releaseReason: null,
      status: "ACTIVE",
    });
    expect((await db.select().from(replacementRequests))[0].status).toBe(
      "CANCEL_PENDING",
    );
    expect((await db.select().from(shipmentFulfillments))[1].status).toBe(
      "CANCEL_PENDING",
    );

    await applyJifengOrderStatus({
      detail: { erpNo: replacementErpNo, status: 9 },
      source: "POLL",
    });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      releaseReason: "极风状态同步确认包裹已取消",
      status: "RELEASED",
    });
    expect((await db.select().from(replacementRequests))[0].status).toBe("CANCELLED");
    expect((await db.select().from(shipmentFulfillments))[1].status).toBe("CANCELLED");
    expect(
      (await db.select().from(auditLogs)).some(
        (entry) => entry.action === "JIFENG_SHIPMENT_CANCELLED",
      ),
    ).toBe(true);
  });

  test("cancels a replacement package without changing its paid unified settlement", async () => {
    const fixture = await createShippedFixture();
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-REPL-${crypto.randomUUID().slice(0, 8)}`,
        closedAt: new Date("2026-08-20T01:00:00.000Z"),
        customerId: fixture.customer.id,
        idempotencyKey: `replacement-${crypto.randomUUID()}`,
        offlineAmountFen: 900,
        paidAt: new Date("2026-08-20T01:00:00.000Z"),
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        status: "PAID",
        totalAmountFen: 900,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 900,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 900,
      walletAmountFen: 0,
    });
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "验证已结算订单补发取消",
    });

    await expect(
      cancelJifengShipment({
        actorUserId: "auth-admin-replacement",
        reason: "补发不再需要",
        shipmentId: created.replacementShipmentId,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });

    expect((await db.select().from(replacementRequests))[0].status).toBe("CANCELLED");
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "PAID" }]);
  });

  test("does not submit a second cancellation while one is already in progress", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "取消处理中测试",
    });
    await db
      .update(shipmentFulfillments)
      .set({ status: "CANCEL_PENDING" })
      .where(eq(shipmentFulfillments.shipmentId, created.replacementShipmentId));
    const cancelOrder = vi.fn(async () => ({ data: null }));

    await expect(
      cancelJifengShipment({
        actorUserId: "auth-admin-replacement",
        client: { cancelOrder },
        reason: "不要重复提交",
        shipmentId: created.replacementShipmentId,
      }),
    ).rejects.toMatchObject({ code: "CANCELLATION_IN_PROGRESS" });

    expect(cancelOrder).not.toHaveBeenCalled();
    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, created.replacementRequestId));
    expect(reservation.status).toBe("ACTIVE");
  });

  test("does not cancel while the same package is being submitted to Jifeng", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "提交竞态测试",
    });
    await db
      .update(integrationOutbox)
      .set({ status: "PROCESSING" })
      .where(eq(integrationOutbox.aggregateId, created.replacementShipmentId));
    const cancelOrder = vi.fn(async () => ({ data: null }));

    await expect(
      cancelJifengShipment({
        actorUserId: "auth-admin-replacement",
        client: { cancelOrder },
        reason: "不要与创建请求并发",
        shipmentId: created.replacementShipmentId,
      }),
    ).rejects.toMatchObject({ code: "FULFILLMENT_SUBMISSION_IN_PROGRESS" });

    expect(cancelOrder).not.toHaveBeenCalled();
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, created.replacementShipmentId));
    expect(fulfillment.status).toBe("PENDING");
  });

  test("does not release inventory twice when status sync confirms cancellation first", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "取消竞态测试",
    });
    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, created.replacementShipmentId));
    const [replacementShipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.id, created.replacementShipmentId));
    const replacementErpNo = `JF-ERP-${created.replacementRequestId}`;
    await processJifengExistingOrderMatchEvent({
      client: {
        async getOrder({ platformOrderNo }) {
          expect(platformOrderNo).toBe(replacementShipment.externalOrderNo);
          return {
            erpNo: replacementErpNo,
            orderNo: "JF-REPLACEMENT-BEFORE-RACE",
            platformOrderNo,
            status: 2,
          };
        },
      },
      eventId: event.id,
    });

    await expect(
      cancelJifengShipment({
        actorUserId: "auth-admin-replacement",
        client: {
          async cancelOrder() {
            await applyJifengOrderStatus({
              detail: { erpNo: replacementErpNo, status: 9 },
              source: "POLL",
            });
            return { data: null, requestId: "cancel-confirmed-by-sync" };
          },
        },
        reason: "状态同步先确认取消",
        shipmentId: created.replacementShipmentId,
      }),
    ).resolves.toEqual({ status: "ALREADY_CANCELLED" });

    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, created.replacementRequestId));
    expect(reservation).toMatchObject({ quantity: 1, status: "RELEASED" });
    expect(
      (await db.select().from(auditLogs)).filter(
        (entry) => entry.action === "JIFENG_SHIPMENT_CANCELLED",
      ),
    ).toHaveLength(1);
  });

  test("cancels a never-submitted package locally without requiring an enabled Jifeng connection", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "disabled cancellation gate fixture",
    });
    const now = new Date();
    await db.insert(jifengConnections).values({
      accessTokenEncrypted: encryptJifengSecret("database-access", actionEncryptionKey),
      accessTokenExpiresAt: new Date(now.getTime() + 60 * 60_000),
      authorizedAt: now,
      authorizedByAdminUserId: fixture.admin.id,
      connectionKey: "PRIMARY",
      logisticsId: 310,
      refreshTokenEncrypted: encryptJifengSecret("database-refresh", actionEncryptionKey),
      refreshTokenExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      status: "READY_DISABLED",
      updatedAt: now,
      userId: "database-user",
      warehouseCode: "CA-YYZ",
    });
    vi.stubEnv("JIFENG_ACCESS_TOKEN", "legacy-access-token");
    vi.stubEnv("JIFENG_BASE_URL", "https://jifeng.example.test");
    vi.stubEnv("JIFENG_CLIENT_ID", "client-id");
    vi.stubEnv("JIFENG_CLIENT_SECRET", "client-secret");
    vi.stubEnv("JIFENG_LEGACY_FULFILLMENT_ENABLED", "true");
    vi.stubEnv("JIFENG_LOGISTICS_ID", "999");
    vi.stubEnv("JIFENG_TOKEN_ENCRYPTION_KEY", actionEncryptionKey.toString("base64url"));
    vi.stubEnv("JIFENG_USER_ID", "legacy-user");
    vi.stubEnv("JIFENG_WAREHOUSE_CODE", "LEGACY-WAREHOUSE");
    const fetchMock = vi.fn(async () =>
      Response.json({ code: 0, data: null, message: "SUCCESS" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const formData = new FormData();
    formData.set("orderId", fixture.order.id);
    formData.set("reason", "connection disabled");
    formData.set("shipmentId", created.replacementShipmentId);

    await expect(
      cancelJifengShipmentAction({ status: "idle" }, formData),
    ).resolves.toMatchObject({ status: "success" });

    expect(fetchMock).not.toHaveBeenCalled();
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, created.replacementShipmentId));
    expect(fulfillment.status).toBe("CANCELLED");
    const [reservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.referenceId, created.replacementRequestId));
    expect(reservation.status).toBe("RELEASED");
  });

  test.each([
    [6, "FULFILLING", "FULFILLING", "ACTIVE", 10],
    [7, "SHIPPED", "SHIPPED", "CONSUMED", 9],
    [9, "CANCELLED", "CANCELLED", "RELEASED", 10],
    [8, "EXCEPTION", "EXCEPTION", "ACTIVE", 10],
  ] as const)(
    "maps reconciled replacement Jifeng status %s without flattening lifecycle semantics",
    async (
      jifengStatus,
      expectedFulfillment,
      expectedReplacement,
      expectedReservation,
      expectedInventory,
    ) => {
      const fixture = await createShippedFixture();
      const created = await createReplacementRequest({
        actorUserId: "auth-admin-replacement",
        adminUserId: fixture.admin.id,
        items: [{ quantity: 1, skuId: fixture.sku.id }],
        originalShipmentId: fixture.shipment.id,
        reason: "replacement reconciliation status mapping",
      });
      const [event] = await db
        .select()
        .from(integrationOutbox)
        .where(eq(integrationOutbox.aggregateId, created.replacementShipmentId));
      const [fulfillment] = await db
        .select()
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.shipmentId, created.replacementShipmentId));
      const [replacementShipment] = await db
        .select()
        .from(orderShipments)
        .where(eq(orderShipments.id, created.replacementShipmentId));
      const replacementErpNo = `JF-ERP-${created.replacementRequestId}`;
      await expect(
        processJifengExistingOrderMatchEvent({
          client: {
            async getOrder({ platformOrderNo }) {
              expect(platformOrderNo).toBe(replacementShipment.externalOrderNo);
              return {
                erpNo: replacementErpNo,
                orderNo: `JF-REPL-${jifengStatus}`,
                platformOrderNo,
                shippedTime:
                  jifengStatus === 7 ? "2026-08-12T09:00:00.000Z" : undefined,
                status: jifengStatus,
                trackingNo: jifengStatus === 7 ? "CP-RECONCILED" : undefined,
              };
            },
          },
          eventId: event.id,
        }),
      ).resolves.toEqual({ status: "MATCHED" });

      const [savedFulfillment] = await db
        .select()
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.id, fulfillment.id));
      const [savedReplacement] = await db
        .select()
        .from(replacementRequests)
        .where(eq(replacementRequests.id, created.replacementRequestId));
      const [savedReservation] = await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.referenceId, created.replacementRequestId));
      const [savedInventory] = await db
        .select()
        .from(inventoryBalances)
        .where(eq(inventoryBalances.skuId, fixture.sku.id));
      const [savedOrder] = await db
        .select()
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, fixture.order.id));
      expect(savedFulfillment).toMatchObject({
        externalOrderNo: `JF-REPL-${jifengStatus}`,
        jifengStatus,
        status: expectedFulfillment,
      });
      expect(savedReplacement.status).toBe(expectedReplacement);
      expect(savedReservation.status).toBe(expectedReservation);
      expect(savedInventory.totalQuantity).toBe(expectedInventory);
      expect(savedOrder.status).toBe("SHIPPED");
      if (jifengStatus === 7) {
        const [savedShipment] = await db
          .select()
          .from(orderShipments)
          .where(eq(orderShipments.id, created.replacementShipmentId));
        expect(savedShipment.trackingNumber).toBe("CP-RECONCILED");
        expect(savedShipment.shippedAt).toEqual(
          new Date("2026-08-12T09:00:00.000Z"),
        );
      }
    },
  );

  test("retries exact replacement lookup after post-success persistence failure without duplicate binding", async () => {
    const fixture = await createShippedFixture();
    const created = await createReplacementRequest({
      actorUserId: "auth-admin-replacement",
      adminUserId: fixture.admin.id,
      items: [{ quantity: 1, skuId: fixture.sku.id }],
      originalShipmentId: fixture.shipment.id,
      reason: "replacement post-success persistence reconciliation",
    });
    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.aggregateId, created.replacementShipmentId));
    const [replacementShipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.id, created.replacementShipmentId));
    let lookupCalls = 0;
    const replacementErpNo = `JF-ERP-${created.replacementRequestId}`;
    const client = {
      async getOrder({ platformOrderNo }: { platformOrderNo: string }) {
        lookupCalls += 1;
        expect(platformOrderNo).toBe(replacementShipment.externalOrderNo);
        return {
          erpNo: replacementErpNo,
          orderNo: "JF-REPL-POST-SUCCESS",
          platformOrderNo,
          status: 6,
        };
      },
    };
    await db.execute(sql.raw(`
      create function test_fail_replacement_success_attempt() returns trigger language plpgsql as $$
      begin
        if new.outcome = 'SUCCESS' then raise exception 'injected'; end if;
        return new;
      end;
      $$;
      create trigger test_fail_replacement_success_attempt_trigger
      before insert on integration_attempts
      for each row execute function test_fail_replacement_success_attempt();
    `));
    try {
      await processJifengExistingOrderMatchEvent({
        client,
        eventId: event.id,
      });
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists test_fail_replacement_success_attempt_trigger on integration_attempts;
        drop function if exists test_fail_replacement_success_attempt();
      `));
    }
    await processJifengExistingOrderMatchEvent({
      client,
      eventId: event.id,
    });

    expect(lookupCalls).toBe(2);
    expect((await db.select().from(replacementRequests))[0].status).toBe(
      "FULFILLING",
    );
    expect((await db.select().from(fulfillmentOrders))[0].status).toBe("SHIPPED");
  });
});
