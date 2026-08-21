import crypto from "node:crypto";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: vi.fn(async () => ({ kind: "ADMIN" as const, userId: "test-admin" })),
}));

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  orderShipments,
  shipmentCancellationAdjustments,
  stores,
} from "@/db/schema";
import { listPendingOfflineRefunds } from "@/modules/settlement/admin-queries";

describe("pending offline refund query", () => {
  afterEach(async () => {
    await db.execute(sql.raw("truncate table customers, admin_users restart identity cascade"));
  });

  test("lists each pending partial and full cancellation once and removes completed refunds", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values({ code: `REFUND-${suffix}`, name: "退款客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "退款店铺" })
      .returning();
    const [admin] = await db
      .insert(adminUsers)
      .values({
        displayName: "财务管理员",
        loginIdentifier: `refund-admin-${suffix}@example.com`,
      })
      .returning();
    const createdAt = new Date("2026-08-10T04:00:00.000Z");
    const [partialOrder, fullOrder, completedOrder] = await db
      .insert(fulfillmentOrders)
      .values([
        {
          cancellationState: "PARTIAL",
          customerId: customer.id,
          orderNumber: `PARTIAL-${suffix}`,
          paidAt: createdAt,
          paymentMode: "DIRECT_OFFLINE",
          status: "FULFILLING",
          storeId: store.id,
          submittedAt: createdAt,
          totalAmountFen: 2_600,
          totalPackageCount: 2,
          totalQuantity: 2,
        },
        {
          cancelReason: "整单取消",
          cancellationState: "ALL",
          cancelledAt: createdAt,
          customerId: customer.id,
          orderNumber: `FULL-${suffix}`,
          paidAt: createdAt,
          paymentMode: "DIRECT_OFFLINE",
          status: "CANCELLED",
          storeId: store.id,
          submittedAt: createdAt,
          totalAmountFen: 1_300,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          cancelReason: "退款已完成",
          cancellationState: "ALL",
          cancelledAt: createdAt,
          customerId: customer.id,
          orderNumber: `COMPLETED-${suffix}`,
          paidAt: createdAt,
          paymentMode: "DIRECT_OFFLINE",
          status: "CANCELLED",
          storeId: store.id,
          submittedAt: createdAt,
          totalAmountFen: 1_300,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
      ])
      .returning();
    const [partialShipment, fullShipment, completedShipment] = await db
      .insert(orderShipments)
      .values([
        {
          externalOrderNo: `PO-PARTIAL-${suffix}`,
          orderId: partialOrder.id,
          recipientPayloadEncrypted: "encrypted",
          storeId: store.id,
        },
        {
          externalOrderNo: `PO-FULL-${suffix}`,
          orderId: fullOrder.id,
          recipientPayloadEncrypted: "encrypted",
          storeId: store.id,
        },
        {
          externalOrderNo: `PO-COMPLETED-${suffix}`,
          orderId: completedOrder.id,
          recipientPayloadEncrypted: "encrypted",
          storeId: store.id,
        },
      ])
      .returning();
    await db.insert(shipmentCancellationAdjustments).values([
      {
        actorType: "SYSTEM",
        createdAt,
        customerId: customer.id,
        merchandiseAmountFen: 0,
        offlineAmountFen: 1_300,
        orderId: partialOrder.id,
        reason: "部分取消",
        shipmentId: partialShipment.id,
        shippingFeeFen: 1_300,
        status: "PENDING_OFFLINE",
        totalAmountFen: 1_300,
        walletAmountFen: 0,
      },
      {
        actorType: "SYSTEM",
        createdAt: new Date("2026-08-10T04:00:01.000Z"),
        customerId: customer.id,
        merchandiseAmountFen: 0,
        offlineAmountFen: 1_300,
        orderId: fullOrder.id,
        reason: "整单取消",
        shipmentId: fullShipment.id,
        shippingFeeFen: 1_300,
        status: "PENDING_OFFLINE",
        totalAmountFen: 1_300,
        walletAmountFen: 0,
      },
      {
        actorType: "SYSTEM",
        createdAt,
        customerId: customer.id,
        merchandiseAmountFen: 0,
        offlineAmountFen: 1_300,
        offlineCompletedAt: new Date("2026-08-11T04:00:00.000Z"),
        offlineCompletedByAdminUserId: admin.id,
        offlineCompletionNote: "已原路退回",
        orderId: completedOrder.id,
        reason: "整单取消",
        shipmentId: completedShipment.id,
        shippingFeeFen: 1_300,
        status: "COMPLETED",
        totalAmountFen: 1_300,
        walletAmountFen: 0,
      },
    ]);

    const rows = await listPendingOfflineRefunds();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.shipmentId)).toEqual([
      partialShipment.id,
      fullShipment.id,
    ]);
    expect(rows.reduce((sum, row) => sum + row.offlineAmountFen, 0)).toBe(2_600);
    expect(rows).toEqual([
      expect.objectContaining({
        externalOrderNo: `PO-PARTIAL-${suffix}`,
        orderNumber: `PARTIAL-${suffix}`,
      }),
      expect.objectContaining({
        externalOrderNo: `PO-FULL-${suffix}`,
        orderNumber: `FULL-${suffix}`,
      }),
    ]);
  });
});
