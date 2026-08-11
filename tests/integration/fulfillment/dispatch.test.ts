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
  processJifengCreateOrderEvent,
  type JifengCreateOrderPort,
} from "@/modules/fulfillment/dispatch";
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
    expect(updatedOrder.status).toBe("FULFILLMENT_EXCEPTION");
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
});
