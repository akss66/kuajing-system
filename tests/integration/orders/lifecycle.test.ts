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
  orderLines,
  orderShipments,
  paymentClaims,
  products,
  replacementRequests,
  settlementBatchOrders,
  settlementBatches,
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
import {
  getCustomerOrderDetail,
  listAdminOrders,
  listCustomerOrders,
} from "@/modules/orders/queries";

const initialNow = new Date("2026-08-12T10:00:00.000Z");

async function createOrder(input?: {
  customerId?: string;
  lockExpiresAt?: Date | null;
  paymentMode?: "WALLET" | "DIRECT_OFFLINE" | "MIXED" | null;
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

  test.each(["PENDING_PAYMENT", "PAYMENT_REPORTED"] as const)(
    "payment declaration is blocked while the order belongs to an active %s settlement",
    async (settlementStatus) => {
      const { customer, order } = await createOrder();
      const [batch] = await db
        .insert(settlementBatches)
        .values({
          batchNumber: `SET-ACTIVE-${crypto.randomUUID()}`,
          customerId: customer.id,
          idempotencyKey: `active-payment-guard-${crypto.randomUUID()}`,
          offlineAmountFen: 500,
          paymentDueAt: new Date("2026-08-22T00:00:00.000Z"),
          paymentReportedAt:
            settlementStatus === "PAYMENT_REPORTED" ? initialNow : null,
          status: settlementStatus,
          totalAmountFen: 500,
          walletAmountFen: 0,
        })
        .returning();
      await db.insert(settlementBatchOrders).values({
        customerId: customer.id,
        offlineAmountFen: 500,
        orderId: order.id,
        settlementBatchId: batch.id,
        totalAmountFen: 500,
        walletAmountFen: 0,
      });

      await expect(
        declareOfflinePayment({
          actorUserId: "customer-auth-1",
          amountFen: 500,
          customerId: customer.id,
          now: initialNow,
          orderId: order.id,
        }),
      ).rejects.toMatchObject({ code: "ORDER_PAYMENT_MANAGED_BY_SETTLEMENT" });
      expect(await db.select().from(paymentClaims)).toEqual([]);
    },
  );

  test("admin cannot approve a legacy order claim after the order enters active settlement", async () => {
    const { customer, order } = await createOrder();
    const [admin] = await db
      .insert(adminUsers)
      .values({ displayName: "结算保护管理员", loginIdentifier: `guard-${crypto.randomUUID()}@test.local` })
      .returning();
    const claim = await declareOfflinePayment({
      actorUserId: "customer-auth-1",
      amountFen: 500,
      customerId: customer.id,
      now: initialNow,
      orderId: order.id,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-LEGACY-${crypto.randomUUID()}`,
        customerId: customer.id,
        idempotencyKey: `legacy-claim-guard-${crypto.randomUUID()}`,
        offlineAmountFen: 500,
        paymentDueAt: new Date("2026-08-22T00:00:00.000Z"),
        status: "PENDING_PAYMENT",
        totalAmountFen: 500,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: customer.id,
      offlineAmountFen: 500,
      orderId: order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 500,
      walletAmountFen: 0,
    });

    await expect(
      reviewOfflinePayment({
        actorUserId: "admin-auth-1",
        adminUserId: admin.id,
        claimId: claim.claimId,
        decision: "APPROVE",
        now: new Date("2026-08-12T10:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "ORDER_PAYMENT_MANAGED_BY_SETTLEMENT" });
    await expect(
      db.select().from(paymentClaims).where(eq(paymentClaims.id, claim.claimId)),
    ).resolves.toEqual([expect.objectContaining({ status: "PENDING" })]);

    await expect(
      reviewOfflinePayment({
        actorUserId: "admin-auth-1",
        adminUserId: admin.id,
        claimId: claim.claimId,
        decision: "REJECT",
        now: new Date("2026-08-12T10:31:00.000Z"),
        rejectionReason: "统一结算前清理旧的单订单付款声明",
      }),
    ).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
    await expect(
      db.select().from(paymentClaims).where(eq(paymentClaims.id, claim.claimId)),
    ).resolves.toEqual([expect.objectContaining({ status: "REJECTED" })]);
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

  test("customer order detail keeps bundled lines grouped by uploaded sub-order", async () => {
    const { customer, order, sku, store } = await createOrder();
    const [shipmentA, shipmentB] = await db
      .insert(orderShipments)
      .values([
        {
          externalOrderNo: "PACKAGE-A",
          orderId: order.id,
          recipientPayloadEncrypted: "encrypted-a",
          storeId: store.id,
        },
        {
          externalOrderNo: "PACKAGE-B",
          orderId: order.id,
          recipientPayloadEncrypted: "encrypted-b",
          storeId: store.id,
        },
      ])
      .returning();
    const createdAt = new Date("2026-08-12T10:01:00.000Z");
    await db.insert(orderLines).values([
      {
        createdAt,
        externalSubOrderNo: "SUB-A",
        lineAmountFen: 500,
        linePosition: 1,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipmentA.id,
        skuCodeSnapshot: "A-1",
        skuId: sku.id,
        skuNameSnapshot: "A primary",
        storeId: store.id,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5_000,
      },
      {
        createdAt,
        externalSubOrderNo: "SUB-B",
        lineAmountFen: 500,
        linePosition: 1,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipmentB.id,
        skuCodeSnapshot: "B-1",
        skuId: sku.id,
        skuNameSnapshot: "B primary",
        storeId: store.id,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5_000,
      },
      {
        createdAt,
        externalSubOrderNo: "SUB-A",
        lineAmountFen: 500,
        linePosition: 2,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipmentA.id,
        skuCodeSnapshot: "A-2",
        skuId: sku.id,
        skuNameSnapshot: "A bundled",
        storeId: store.id,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5_000,
      },
      {
        createdAt,
        externalSubOrderNo: "SUB-B",
        lineAmountFen: 500,
        linePosition: 2,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipmentB.id,
        skuCodeSnapshot: "B-2",
        skuId: sku.id,
        skuNameSnapshot: "B bundled",
        storeId: store.id,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5_000,
      },
    ]);

    const detail = await getCustomerOrderDetail(customer.id, order.id);

    expect(detail?.lines.map((line) => line.skuCode)).toEqual([
      "A-1",
      "A-2",
      "B-1",
      "B-2",
    ]);
  });

  test("customer order detail returns each order allocation from a mixed settlement batch", async () => {
    const first = await createOrder({
      paymentMode: "MIXED",
      status: "PAID_PENDING_FULFILLMENT",
    });
    const second = await createOrder({
      customerId: first.customer.id,
      paymentMode: "MIXED",
      status: "PAID_PENDING_FULFILLMENT",
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-MIXED-${crypto.randomUUID()}`,
        customerId: first.customer.id,
        idempotencyKey: `mixed-detail-${crypto.randomUUID()}`,
        offlineAmountFen: 800,
        paymentDueAt: new Date("2026-08-22T00:00:00.000Z"),
        status: "PAID",
        totalAmountFen: 1_000,
        walletAmountFen: 200,
      })
      .returning();
    await db.insert(settlementBatchOrders).values([
      {
        customerId: first.customer.id,
        offlineAmountFen: 500,
        orderId: first.order.id,
        settlementBatchId: batch.id,
        totalAmountFen: 500,
        walletAmountFen: 0,
      },
      {
        customerId: first.customer.id,
        offlineAmountFen: 300,
        orderId: second.order.id,
        settlementBatchId: batch.id,
        totalAmountFen: 500,
        walletAmountFen: 200,
      },
    ]);

    await expect(
      getCustomerOrderDetail(first.customer.id, first.order.id),
    ).resolves.toMatchObject({
      offlineAmountFen: 500,
      settlementBatchId: batch.id,
      settlementBatchStatus: "PAID",
      walletAmountFen: 0,
    });
    await expect(
      getCustomerOrderDetail(first.customer.id, second.order.id),
    ).resolves.toMatchObject({
      offlineAmountFen: 300,
      settlementBatchId: batch.id,
      settlementBatchStatus: "PAID",
      walletAmountFen: 200,
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
    const { customer, order, reservation, sku, store } = await createOrder({ lockExpiresAt: expiredAt });
    const [shipment] = await db
      .insert(orderShipments)
      .values({
        externalOrderNo: `EXPIRED-PACKAGE-${crypto.randomUUID()}`,
        orderId: order.id,
        recipientPayloadEncrypted: "test-only-encrypted-payload",
        storeId: store.id,
      })
      .returning();
    const [line] = await db
      .insert(orderLines)
      .values({
        externalSubOrderNo: `EXPIRED-LINE-${crypto.randomUUID()}`,
        lineAmountFen: 500,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: sku.name,
        storeId: store.id,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5000,
      })
      .returning();
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
    await expect(
      db
        .select({ deduplicationActive: orderShipments.deduplicationActive })
        .from(orderShipments)
        .where(eq(orderShipments.id, shipment.id)),
    ).resolves.toEqual([{ deduplicationActive: false }]);
    await expect(
      db
        .select({ deduplicationActive: orderLines.deduplicationActive })
        .from(orderLines)
        .where(eq(orderLines.id, line.id)),
    ).resolves.toEqual([{ deduplicationActive: false }]);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "FULFILLMENT_ORDER_EXPIRED")),
    ).toHaveLength(1);

    expect((await listAdminOrders()).map((row) => row.id)).not.toContain(order.id);
    expect((await listCustomerOrders(customer.id)).map((row) => row.id)).not.toContain(order.id);
    expect((await listAdminOrders({ status: "EXPIRED" })).map((row) => row.id)).toContain(order.id);
    expect((await listCustomerOrders(customer.id, "EXPIRED")).map((row) => row.id)).toContain(order.id);
  });
});
