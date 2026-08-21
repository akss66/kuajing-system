import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  integrationOutbox,
  orderShipments,
  replacementRequests,
  shipmentFulfillments,
  stores,
} from "@/db/schema";

async function createOrderWithShipments() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [customer] = await db
    .insert(customers)
    .values({ code: `FF-${suffix}`, name: "履约约束客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `履约店铺-${suffix}` })
    .returning();
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-FF-${suffix}`,
      paidAt: new Date(),
      paymentMode: "DIRECT_OFFLINE",
      status: "PAID_PENDING_FULFILLMENT",
      storeId: store.id,
      totalAmountFen: 500,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  const [normalShipment, replacementShipment] = await db
    .insert(orderShipments)
    .values([
      {
        externalOrderNo: `TEMU-${suffix}`,
        kind: "NORMAL",
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-normal",
        shippingFeeFen: 1_300,
        storeId: store.id,
      },
      {
        externalOrderNo: `REPLACEMENT-${suffix}`,
        kind: "REPLACEMENT",
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-replacement",
        shippingFeeFen: 0,
        storeId: store.id,
      },
    ])
    .returning();
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: "履约管理员",
      loginIdentifier: `ff-${suffix}@example.com`,
    })
    .returning();
  return { admin, normalShipment, order, replacementShipment };
}

describe("fulfillment integration schema", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        replacement_requests,
        shipment_fulfillments,
        order_lines,
        order_shipments,
        fulfillment_orders,
        admin_users,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("one shipment and one Jifeng ERP number each identify one fulfillment", async () => {
    const { normalShipment, replacementShipment } =
      await createOrderWithShipments();

    await db.insert(shipmentFulfillments).values({
      erpNo: `JF-${normalShipment.id}`,
      shipmentId: normalShipment.id,
    });

    await expect(
      db.insert(shipmentFulfillments).values({
        erpNo: `JF-OTHER-${normalShipment.id}`,
        shipmentId: normalShipment.id,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(shipmentFulfillments).values({
        erpNo: `JF-${normalShipment.id}`,
        shipmentId: replacementShipment.id,
      }),
    ).rejects.toThrow();
  });

  test("rejects a negative package shipping fee snapshot", async () => {
    const { normalShipment } = await createOrderWithShipments();

    await expect(
      db
        .update(orderShipments)
        .set({ shippingFeeFen: -1 })
        .where(sql`${orderShipments.id} = ${normalShipment.id}`),
    ).rejects.toThrow();
  });

  test("a replacement requires the original shipment, administrator and a nonblank reason", async () => {
    const { admin, normalShipment, order, replacementShipment } =
      await createOrderWithShipments();

    await expect(
      db.insert(replacementRequests).values({
        createdByAdminUserId: admin.id,
        orderId: order.id,
        originalShipmentId: normalShipment.id,
        reason: "   ",
        replacementShipmentId: replacementShipment.id,
      }),
    ).rejects.toThrow();

    await db.insert(replacementRequests).values({
      createdByAdminUserId: admin.id,
      orderId: order.id,
      originalShipmentId: normalShipment.id,
      reason: "运输途中损坏，重新补发",
      replacementShipmentId: replacementShipment.id,
    });

    await expect(
      db.insert(replacementRequests).values({
        createdByAdminUserId: admin.id,
        orderId: order.id,
        originalShipmentId: normalShipment.id,
        reason: "不能重复关联同一个补发包裹",
        replacementShipmentId: replacementShipment.id,
      }),
    ).rejects.toThrow();
  });

  test("integration outbox idempotency keys are globally unique", async () => {
    const event = {
      aggregateId: crypto.randomUUID(),
      aggregateType: "SHIPMENT",
      eventType: "JIFENG_CREATE_ORDER",
      idempotencyKey: `jifeng:${crypto.randomUUID()}`,
      payload: { shipmentId: crypto.randomUUID() },
      target: "JIFENG" as const,
    };

    await db.insert(integrationOutbox).values(event);
    await expect(db.insert(integrationOutbox).values(event)).rejects.toThrow();
  });

  test("integration outbox stores a nullable UUID reconciliation claim token", async () => {
    const columns = await db.execute<{
      dataType: string;
      isNullable: string;
    }>(sql`
      select
        data_type as "dataType",
        is_nullable as "isNullable"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'integration_outbox'
        and column_name = 'claim_token'
    `);

    expect(columns).toEqual([
      { dataType: "uuid", isNullable: "YES" },
    ]);

    const indexes = await db.execute<{ indexdef: string }>(sql`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'integration_outbox'
        and indexname = 'integration_outbox_reconciliation_lease_index'
    `);
    expect(indexes[0]?.indexdef).toContain(
      "(target, status, locked_at)",
    );
  });
});
