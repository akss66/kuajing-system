import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

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
  orderLines,
  orderShipments,
  products,
  replacementRequests,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import { processJifengCreateOrderEvent } from "@/modules/fulfillment/dispatch";
import {
  cancelJifengShipment,
  createReplacementRequest,
  ReplacementError,
} from "@/modules/fulfillment/replacement";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";
import { encryptPii } from "@/shared/pii-crypto";

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
  return { admin, order, shipment, sku, store };
}

describe("replacement fulfillment", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
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

    await processJifengCreateOrderEvent({
      client: { async createOrder() { return { data: null, requestId: "repl-create" }; } },
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(10);

    await applyJifengOrderStatus({
      detail: {
        currency: "CAD",
        erpNo: fulfillment.erpNo,
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
    const [fulfillment] = await db
      .select()
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, created.replacementShipmentId));

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
          expect(input).toEqual({ deleteRecord: false, erpNo: fulfillment.erpNo });
          return { data: null, requestId: "cancel-success" };
        },
      },
      reason: "地址需要更正",
      shipmentId: created.replacementShipmentId,
    });
    expect((await db.select().from(inventoryReservations))[0]).toMatchObject({
      releaseReason: "极风取消确认：地址需要更正",
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

  test.each([
    [6, "FULFILLING", "FULFILLING", "ACTIVE", 10],
    [7, "SHIPPED", "SHIPPED", "CONSUMED", 9],
    [9, "CANCELLED", "CANCELLED", "ACTIVE", 10],
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
      await processJifengCreateOrderEvent({
        client: {
          async createOrder() {
            throw new JifengApiError({
              code: "TIMEOUT",
              message: "ambiguous replacement create",
              retryable: true,
            });
          },
        },
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
      });

      await expect(
        processJifengCreateOrderEvent({
          client: {
            async createOrder() {
              throw new Error("replacement create must not repeat");
            },
            async getOrder({ erpNo }) {
              return {
                erpNo,
                orderNo: `JF-REPL-${jifengStatus}`,
                shippedTime:
                  jifengStatus === 7 ? "2026-08-12T09:00:00.000Z" : undefined,
                status: jifengStatus,
                trackingNo: jifengStatus === 7 ? "CP-RECONCILED" : undefined,
              };
            },
          },
          config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
          eventId: event.id,
        }),
      ).resolves.toEqual({ status: "RECONCILED" });

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

  test("reconciles a replacement after post-success persistence failure without repeating create", async () => {
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
    let createCalls = 0;
    const client = {
      async createOrder() {
        createCalls += 1;
        return { data: null };
      },
      async getOrder({ erpNo }: { erpNo: string }) {
        return { erpNo, orderNo: "JF-REPL-POST-SUCCESS", status: 6 };
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
      await processJifengCreateOrderEvent({
        client,
        config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
        eventId: event.id,
      });
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists test_fail_replacement_success_attempt_trigger on integration_attempts;
        drop function if exists test_fail_replacement_success_attempt();
      `));
    }
    await processJifengCreateOrderEvent({
      client,
      config: { logisticsId: 310, warehouseCode: "CA-YYZ" },
      eventId: event.id,
    });

    expect(createCalls).toBe(1);
    expect((await db.select().from(replacementRequests))[0].status).toBe(
      "FULFILLING",
    );
    expect((await db.select().from(fulfillmentOrders))[0].status).toBe("SHIPPED");
  });
});
