import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderShipments,
  paymentClaims,
  products,
  replacementRequests,
  shipmentFulfillments,
  skus,
  stores,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";
import {
  cancelFulfillmentOrder,
  declareOfflinePayment,
  expirePendingPaymentOrders,
  reviewOfflinePayment,
} from "@/modules/orders/lifecycle";
import { getCustomerOrderDetail } from "@/modules/orders/queries";

const initialNow = new Date("2026-08-12T10:00:00.000Z");

async function createOrder(input?: {
  customerId?: string;
  lockExpiresAt?: Date | null;
  paymentMode?: "WALLET" | "DIRECT_OFFLINE" | null;
  status?: "PENDING_PAYMENT" | "PAID_PENDING_FULFILLMENT";
}) {
  const customer = input?.customerId
    ? { id: input.customerId }
    : (
        await db
          .insert(customers)
          .values({ code: `LC-${crypto.randomUUID()}`, name: "生命周期客户" })
          .returning()
      )[0];
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `生命周期店铺-${crypto.randomUUID()}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `生命周期商品-${crypto.randomUUID()}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 500,
      name: "生命周期 SKU",
      productId: product.id,
      skuCode: `LC-SKU-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });

  const status = input?.status ?? "PENDING_PAYMENT";
  const lockExpiresAt =
    input?.lockExpiresAt === undefined
      ? new Date(initialNow.getTime() + 2 * 60 * 60 * 1000)
      : input.lockExpiresAt;
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      lockExpiresAt,
      orderNumber: `TZX-LC-${crypto.randomUUID().slice(0, 24)}`,
      paidAt: status === "PAID_PENDING_FULFILLMENT" ? initialNow : null,
      paymentMode: input?.paymentMode ?? null,
      status,
      storeId: store.id,
      totalAmountFen: 500,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  const [reservation] = await db
    .insert(inventoryReservations)
    .values({
      expiresAt: lockExpiresAt,
      quantity: 1,
      referenceId: order.id,
      referenceType: "FULFILLMENT_ORDER",
      skuId: sku.id,
    })
    .returning();

  return { customer, order, reservation, sku, store };
}

describe("offline payment and order lifecycle", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        payment_claims,
        wallet_transactions,
        wallet_accounts,
        order_lines,
        order_shipments,
        fulfillment_orders,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        admin_users,
        stores,
        skus,
        products,
        customers
      restart identity cascade
    `));
  });

  test("customer payment declaration extends the order and reservation lock to twelve hours", async () => {
    const { customer, order, reservation } = await createOrder();

    const result = await declareOfflinePayment({
      actorUserId: "customer-auth-1",
      amountFen: 500,
      customerId: customer.id,
      note: "微信已付款",
      now: initialNow,
      orderId: order.id,
    });

    const expectedExpiry = new Date("2026-08-12T22:00:00.000Z");
    expect(result).toMatchObject({ amountFen: 500, status: "PENDING" });
    expect(result.lockExpiresAt).toEqual(expectedExpiry);
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.paymentDeclaredAt).toEqual(initialNow);
    expect(savedOrder.lockExpiresAt).toEqual(expectedExpiry);
    const [savedReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservation.id));
    expect(savedReservation.expiresAt).toEqual(expectedExpiry);
    expect(await db.select().from(paymentClaims)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "OFFLINE_PAYMENT_DECLARED")),
    ).toHaveLength(1);
  });

  test("payment declaration rejects a different customer and a mismatched amount", async () => {
    const { customer, order } = await createOrder();
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: `OTHER-${crypto.randomUUID().slice(0, 24)}`, name: "其他客户" })
      .returning();

    await expect(
      declareOfflinePayment({
        actorUserId: "customer-auth-2",
        amountFen: 500,
        customerId: otherCustomer.id,
        now: initialNow,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await expect(
      declareOfflinePayment({
        actorUserId: "customer-auth-1",
        amountFen: 499,
        customerId: customer.id,
        now: initialNow,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
    expect(await db.select().from(paymentClaims)).toEqual([]);
  });

  test("admin approval marks direct payment paid without touching the wallet", async () => {
    const { customer, order, reservation } = await createOrder();
    const [admin] = await db
      .insert(adminUsers)
      .values({ displayName: "超级管理员", loginIdentifier: `admin-${crypto.randomUUID()}@test.local` })
      .returning();
    const claim = await declareOfflinePayment({
      actorUserId: "customer-auth-1",
      amountFen: 500,
      customerId: customer.id,
      now: initialNow,
      orderId: order.id,
    });
    const reviewedAt = new Date("2026-08-12T10:30:00.000Z");

    await reviewOfflinePayment({
      actorUserId: "admin-auth-1",
      adminUserId: admin.id,
      claimId: claim.claimId,
      decision: "APPROVE",
      now: reviewedAt,
    });

    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder).toMatchObject({
      lockExpiresAt: null,
      paidAt: reviewedAt,
      paymentMode: "DIRECT_OFFLINE",
      status: "PAID_PENDING_FULFILLMENT",
    });
    const [savedClaim] = await db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, claim.claimId));
    expect(savedClaim).toMatchObject({
      reviewedAt,
      reviewedByAdminUserId: admin.id,
      status: "APPROVED",
    });
    const [savedReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservation.id));
    expect(savedReservation.expiresAt).toBeNull();
    expect(await db.select().from(walletTransactions)).toEqual([]);
  });

  test("admin rejection requires a reason and restores a two-hour payment lock", async () => {
    const { customer, order, reservation } = await createOrder();
    const [admin] = await db
      .insert(adminUsers)
      .values({ displayName: "超级管理员", loginIdentifier: `admin-${crypto.randomUUID()}@test.local` })
      .returning();
    const claim = await declareOfflinePayment({
      actorUserId: "customer-auth-1",
      amountFen: 500,
      customerId: customer.id,
      now: initialNow,
      orderId: order.id,
    });
    const reviewedAt = new Date("2026-08-12T10:30:00.000Z");

    await expect(
      reviewOfflinePayment({
        actorUserId: "admin-auth-1",
        adminUserId: admin.id,
        claimId: claim.claimId,
        decision: "REJECT",
        now: reviewedAt,
        rejectionReason: "   ",
      }),
    ).rejects.toMatchObject({ code: "REJECTION_REASON_REQUIRED" });
    await expect(
      reviewOfflinePayment({
        actorUserId: "admin-auth-1",
        adminUserId: admin.id,
        claimId: claim.claimId,
        decision: "REJECT",
        now: reviewedAt,
        rejectionReason: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "REJECTION_REASON_TOO_LONG" });
    await reviewOfflinePayment({
      actorUserId: "admin-auth-1",
      adminUserId: admin.id,
      claimId: claim.claimId,
      decision: "REJECT",
      now: reviewedAt,
      rejectionReason: "未查询到对应微信收款",
    });

    const restoredExpiry = new Date("2026-08-12T12:30:00.000Z");
    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder).toMatchObject({
      lockExpiresAt: restoredExpiry,
      paymentDeclaredAt: null,
      status: "PENDING_PAYMENT",
    });
    const [savedReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservation.id));
    expect(savedReservation.expiresAt).toEqual(restoredExpiry);
    const [savedClaim] = await db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, claim.claimId));
    expect(savedClaim).toMatchObject({
      rejectionReason: "未查询到对应微信收款",
      status: "REJECTED",
    });
  });

  test("cancelling a wallet-paid order releases stock and refunds exactly once", async () => {
    const { customer, order, reservation } = await createOrder({
      lockExpiresAt: null,
      paymentMode: "WALLET",
      status: "PAID_PENDING_FULFILLMENT",
    });
    await db.insert(walletAccounts).values({ balanceFen: 500, customerId: customer.id });
    await db.insert(walletTransactions).values({
      actorId: "customer-auth-1",
      actorType: "SYSTEM",
      afterBalanceFen: 500,
      beforeBalanceFen: 1000,
      customerId: customer.id,
      deltaFen: -500,
      orderId: order.id,
      reason: "订单自动扣款",
      transactionType: "ORDER_DEBIT",
    });

    await cancelFulfillmentOrder({
      actorType: "CUSTOMER",
      actorUserId: "customer-auth-1",
      customerId: customer.id,
      now: initialNow,
      orderId: order.id,
      reason: "客户不再需要",
    });
    await cancelFulfillmentOrder({
      actorType: "CUSTOMER",
      actorUserId: "customer-auth-1",
      customerId: customer.id,
      now: initialNow,
      orderId: order.id,
      reason: "客户不再需要",
    });

    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder).toMatchObject({
      cancelReason: "客户不再需要",
      cancelledAt: initialNow,
      status: "CANCELLED",
    });
    const [savedReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservation.id));
    expect(savedReservation).toMatchObject({
      releaseReason: "订单取消：客户不再需要",
      status: "RELEASED",
    });
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(1000);
    const refunds = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_REFUND"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      afterBalanceFen: 1000,
      beforeBalanceFen: 500,
      deltaFen: 500,
      orderId: order.id,
    });
    await expect(getCustomerOrderDetail(customer.id, order.id)).resolves.toMatchObject({
      paidAt: initialNow,
      refundedAt: refunds[0].createdAt,
      status: "CANCELLED",
    });
  });

  test("customer cannot cancel another customer's order", async () => {
    const { order } = await createOrder();
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: `OTHER-${crypto.randomUUID().slice(0, 24)}`, name: "其他客户" })
      .returning();

    await expect(
      cancelFulfillmentOrder({
        actorType: "CUSTOMER",
        actorUserId: "other-customer-auth",
        customerId: otherCustomer.id,
        now: initialNow,
        orderId: order.id,
        reason: "越权取消测试",
      }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });

    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("PENDING_PAYMENT");
  });

  test("customer order detail returns null for another customer's order", async () => {
    const { customer, order } = await createOrder();
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: `OTHER-${crypto.randomUUID().slice(0, 24)}`, name: "Other customer" })
      .returning();

    await expect(getCustomerOrderDetail(otherCustomer.id, order.id)).resolves.toBeNull();
    await expect(getCustomerOrderDetail(customer.id, order.id)).resolves.toMatchObject({
      id: order.id,
      orderNumber: order.orderNumber,
    });
  });

  test("customer order detail returns real shipment and replacement statuses", async () => {
    const { customer, order, store } = await createOrder({
      paymentMode: "WALLET",
      status: "PAID_PENDING_FULFILLMENT",
    });
    await db
      .update(fulfillmentOrders)
      .set({ status: "SHIPPED" })
      .where(eq(fulfillmentOrders.id, order.id));
    const [admin] = await db
      .insert(adminUsers)
      .values({
        displayName: "Customer detail fulfillment admin",
        loginIdentifier: `customer-detail-${crypto.randomUUID()}@example.test`,
      })
      .returning();
    const [normalShipment, replacementShipment] = await db
      .insert(orderShipments)
      .values([
        {
          createdAt: new Date("2026-08-12T10:10:00.000Z"),
          externalOrderNo: `NORMAL-${crypto.randomUUID()}`,
          orderId: order.id,
          recipientPayloadEncrypted: "encrypted-test-recipient",
          storeId: store.id,
        },
        {
          createdAt: new Date("2026-08-12T10:20:00.000Z"),
          externalOrderNo: `REPLACEMENT-${crypto.randomUUID()}`,
          kind: "REPLACEMENT",
          orderId: order.id,
          recipientPayloadEncrypted: "encrypted-test-recipient",
          storeId: store.id,
        },
      ])
      .returning();
    await db.insert(shipmentFulfillments).values([
      {
        erpNo: `ERP-NORMAL-${crypto.randomUUID()}`,
        shipmentId: normalShipment.id,
        status: "SHIPPED",
      },
      {
        erpNo: `ERP-REPLACEMENT-${crypto.randomUUID()}`,
        shipmentId: replacementShipment.id,
        status: "FULFILLING",
      },
    ]);
    await db.insert(replacementRequests).values({
      createdByAdminUserId: admin.id,
      orderId: order.id,
      originalShipmentId: normalShipment.id,
      reason: "Damaged during shipping",
      replacementShipmentId: replacementShipment.id,
      status: "FULFILLING",
    });

    await expect(getCustomerOrderDetail(customer.id, order.id)).resolves.toMatchObject({
      shipments: [
        {
          fulfillmentStatus: "SHIPPED",
          id: normalShipment.id,
          kind: "NORMAL",
          replacementStatus: null,
        },
        {
          fulfillmentStatus: "FULFILLING",
          id: replacementShipment.id,
          kind: "REPLACEMENT",
          replacementStatus: "FULFILLING",
        },
      ],
    });
  });

  test("expiration is idempotent and releases stale reservations", async () => {
    const expiredAt = new Date("2026-08-12T09:59:00.000Z");
    const { customer, order, reservation } = await createOrder({ lockExpiresAt: expiredAt });
    await db.insert(paymentClaims).values({
      amountFen: 500,
      customerId: customer.id,
      note: "等待核款但已超时",
      orderId: order.id,
    });

    expect(await expirePendingPaymentOrders({ now: initialNow })).toBe(1);
    expect(await expirePendingPaymentOrders({ now: initialNow })).toBe(0);

    const [savedOrder] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, order.id));
    expect(savedOrder.status).toBe("EXPIRED");
    const [savedReservation] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservation.id));
    expect(savedReservation).toMatchObject({
      releaseReason: "待付款订单超时",
      status: "RELEASED",
    });
    const [savedClaim] = await db.select().from(paymentClaims);
    expect(savedClaim).toMatchObject({
      rejectionReason: "订单等待付款或核款超时",
      status: "REJECTED",
    });
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "FULFILLMENT_ORDER_EXPIRED")),
    ).toHaveLength(1);
  });
});
