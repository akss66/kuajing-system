import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderLines,
  orderShipments,
  paymentClaims,
  products,
  settlementBatchOrders,
  settlementBatches,
  shipmentFulfillments,
  skus,
  stores,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";
import {
  completeOfflinePackageRefund,
  recordPackageCancellationAdjustment,
} from "@/modules/fulfillment/package-cancellation-adjustment";
import {
  cancelAllCancellableOrderShipments,
  completeAllOfflineOrderRefunds,
} from "@/modules/fulfillment/order-operations";
import { cancelJifengShipment } from "@/modules/fulfillment/replacement";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";
import { cancelFulfillmentOrder, declareOfflinePayment } from "@/modules/orders/lifecycle";
import { getAdminOrderDetail, getCustomerOrderDetail, listCustomerOrders } from "@/modules/orders/queries";
import { reportSettlementPayment } from "@/modules/settlement/batch-service";
import { encryptPii } from "@/shared/pii-crypto";

const recipientPayloadEncrypted = encryptPii({
  addressLine1: "400 Example Street",
  addressLine2: null,
  addressLine3: null,
  alternatePhone: null,
  city: "Ottawa",
  country: "Canada",
  district: null,
  email: null,
  identityNumber: null,
  name: "Package Refund Recipient",
  phone: "+1 613 555 0120",
  postalCode: "K1A 0B1",
  province: "Ontario",
  taxNumber: null,
});

async function createPaidTwoPackageOrder(input: {
  paymentMode: "DIRECT_OFFLINE" | "MIXED" | "WALLET" | null;
  walletAmountFen: number;
}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: "包裹退款管理员",
      loginIdentifier: `package-refund-${suffix}@example.com`,
    })
    .returning();
  const [customer] = await db
    .insert(customers)
    .values({ code: `PR-${suffix}`, name: "包裹退款客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `包裹退款店铺-${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `包裹退款商品-${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 500,
      name: "包裹退款 SKU",
      productId: product.id,
      skuCode: `TZX-PR-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });

  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-PR-${suffix}`,
      lockExpiresAt: input.paymentMode ? null : new Date("2026-08-20T05:00:00.000Z"),
      paidAt: input.paymentMode ? new Date("2026-08-20T01:00:00.000Z") : null,
      paymentMode: input.paymentMode,
      status: input.paymentMode ? "PAID_PENDING_FULFILLMENT" : "PENDING_PAYMENT",
      storeId: store.id,
      totalAmountFen: 3_800,
      totalPackageCount: 2,
      totalQuantity: 2,
    })
    .returning();
  const shipments = await db
    .insert(orderShipments)
    .values([
      {
        externalOrderNo: `TEMU-PR-${suffix}-1`,
        orderId: order.id,
        recipientPayloadEncrypted,
        storeId: store.id,
      },
      {
        externalOrderNo: `TEMU-PR-${suffix}-2`,
        orderId: order.id,
        recipientPayloadEncrypted,
        storeId: store.id,
      },
    ])
    .returning();
  await db.insert(orderLines).values([
    {
      externalSubOrderNo: `TEMU-PR-LINE-${suffix}-1`,
      lineAmountFen: 500,
      orderId: order.id,
      quantity: 1,
      shipmentId: shipments[0].id,
      skuCodeSnapshot: sku.skuCode,
      skuId: sku.id,
      skuNameSnapshot: sku.name,
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
    {
      externalSubOrderNo: `TEMU-PR-LINE-${suffix}-2`,
      lineAmountFen: 700,
      orderId: order.id,
      quantity: 1,
      shipmentId: shipments[1].id,
      skuCodeSnapshot: sku.skuCode,
      skuId: sku.id,
      skuNameSnapshot: sku.name,
      storeId: store.id,
      unitPriceFen: 700,
      unitPriceMilliYuan: 7_000,
    },
  ]);
  const fulfillments = await db
    .insert(shipmentFulfillments)
    .values([
      { erpNo: `TZX-PR-ERP-${suffix}-1`, shipmentId: shipments[0].id },
      { erpNo: `TZX-PR-ERP-${suffix}-2`, shipmentId: shipments[1].id },
    ])
    .returning();
  await db.insert(inventoryReservations).values({
    quantity: 2,
    referenceId: order.id,
    referenceType: "FULFILLMENT_ORDER",
    skuId: sku.id,
  });

  if (input.walletAmountFen > 0) {
    await db.insert(walletAccounts).values({ balanceFen: 100, customerId: customer.id });
    await db.insert(walletTransactions).values({
      actorId: customer.id,
      actorType: "CUSTOMER",
      afterBalanceFen: 100,
      beforeBalanceFen: 100 + input.walletAmountFen,
      customerId: customer.id,
      deltaFen: -input.walletAmountFen,
      orderId: order.id,
      reason: "测试订单钱包扣款",
      transactionType: "ORDER_DEBIT",
    });
  }

  return { admin, customer, fulfillments, order, shipments };
}

type RefundRow = {
  merchandiseAmountFen: number;
  offlineAmountFen: number;
  shippingFeeFen: number;
  shipmentId: string;
  status: string;
  totalAmountFen: number;
  walletAmountFen: number;
};

async function refundRows(orderId: string) {
  return db.execute<RefundRow>(sql`
    select
      merchandise_amount_fen as "merchandiseAmountFen",
      offline_amount_fen as "offlineAmountFen",
      shipping_fee_fen as "shippingFeeFen",
      shipment_id as "shipmentId",
      status,
      total_amount_fen as "totalAmountFen",
      wallet_amount_fen as "walletAmountFen"
    from shipment_cancellation_adjustments
    where order_id = ${orderId}
    order by created_at, shipment_id
  `);
}

describe("paid package cancellation refunds", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        integration_outbox,
        shipment_fulfillments,
        inventory_reservations,
        wallet_transactions,
        wallet_accounts,
        order_lines,
        order_shipments,
        fulfillment_orders,
        inventory_balances,
        admin_users,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("refunds merchandise and the 13 yuan package fee after Jifeng accepts then confirms cancellation", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .update(shipmentFulfillments)
      .set({
        attemptCount: 1,
        externalOrderNo: "JF-ACCEPTED-1",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T01:05:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        client: {
          async cancelOrder() {
            return { data: null, requestId: "cancel-accepted-package" };
          },
        },
        reason: "客户取消已接单包裹",
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({ status: "CANCEL_PENDING" });

    await expect(refundRows(fixture.order.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ status: shipmentFulfillments.status })
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id)),
    ).resolves.toEqual([{ status: "CANCEL_PENDING" }]);

    await expect(
      applyJifengOrderStatus({
        detail: {
          erpNo: fixture.fulfillments[0].erpNo,
          orderNo: "JF-ACCEPTED-1",
          status: 2,
        },
        now: new Date("2026-08-20T01:05:30.000Z"),
        source: "POLL",
      }),
    ).resolves.toMatchObject({ status: "CANCEL_PENDING" });
    await expect(refundRows(fixture.order.id)).resolves.toEqual([]);

    await expect(
      applyJifengOrderStatus({
        detail: {
          erpNo: fixture.fulfillments[0].erpNo,
          orderNo: "JF-ACCEPTED-1",
          status: 9,
        },
        now: new Date("2026-08-20T01:06:00.000Z"),
        source: "POLL",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    const pendingRefunds = await refundRows(fixture.order.id);
    expect(pendingRefunds).toEqual([
      expect.objectContaining({
        merchandiseAmountFen: 500,
        offlineAmountFen: 1_800,
        shippingFeeFen: 1_300,
        shipmentId: fixture.shipments[0].id,
        status: "PENDING_OFFLINE",
        totalAmountFen: 1_800,
        walletAmountFen: 0,
      }),
    ]);
    const adjustmentRows = await db.execute<{ id: string }>(sql`
      select id
      from shipment_cancellation_adjustments
      where shipment_id = ${fixture.shipments[0].id}
    `);
    await expect(
      completeOfflinePackageRefund({
        actorUserId: "admin-auth-refund",
        adjustmentId: adjustmentRows[0].id,
        adminUserId: fixture.admin.id,
        note: "微信退款流水 REFUND-001",
        now: new Date("2026-08-20T02:30:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(
      completeOfflinePackageRefund({
        actorUserId: "admin-auth-refund",
        adjustmentId: adjustmentRows[0].id,
        adminUserId: fixture.admin.id,
        note: "重复点击不重复处理",
      }),
    ).resolves.toMatchObject({ status: "ALREADY_COMPLETED" });
    await expect(
      getCustomerOrderDetail(fixture.customer.id, fixture.order.id),
    ).resolves.toMatchObject({
      adjustedAmountFen: 1_800,
      cancellationState: "PARTIAL",
      netAmountFen: 2_000,
      totalAmountFen: 3_800,
    });
    await expect(getAdminOrderDetail(fixture.order.id)).resolves.toMatchObject({
      adjustedAmountFen: 1_800,
      netAmountFen: 2_000,
      shipments: expect.arrayContaining([
        expect.objectContaining({
          cancellationAdjustment: expect.objectContaining({ status: "COMPLETED" }),
        }),
      ]),
    });
    await expect(listCustomerOrders(fixture.customer.id)).resolves.toEqual([
      expect.objectContaining({ adjustedAmountFen: 1_800, netAmountFen: 2_000 }),
    ]);
    await expect(
      db
        .select({
          cancellationState: fulfillmentOrders.cancellationState,
          status: fulfillmentOrders.status,
        })
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, fixture.order.id)),
    ).resolves.toEqual([
      { cancellationState: "PARTIAL", status: "PAID_PENDING_FULFILLMENT" },
    ]);

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        reason: "取消剩余包裹",
        shipmentId: fixture.shipments[1].id,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });
    expect((await refundRows(fixture.order.id)).reduce((sum, row) => sum + row.totalAmountFen, 0))
      .toBe(3_800);
    await expect(
      db
        .select({ status: fulfillmentOrders.status })
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, fixture.order.id)),
    ).resolves.toEqual([{ status: "CANCELLED" }]);
  });

  test("refunds each package from its immutable shipping fee snapshot across rate changes", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .update(orderShipments)
      .set({ shippingFeeFen: 1_300 })
      .where(eq(orderShipments.id, fixture.shipments[0].id));
    await db
      .update(orderShipments)
      .set({ shippingFeeFen: 1_700 })
      .where(eq(orderShipments.id, fixture.shipments[1].id));
    await db
      .update(fulfillmentOrders)
      .set({ totalAmountFen: 4_200 })
      .where(eq(fulfillmentOrders.id, fixture.order.id));

    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "取消旧费率包裹",
      shipmentId: fixture.shipments[0].id,
    });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "取消新费率包裹",
      shipmentId: fixture.shipments[1].id,
    });

    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({
        merchandiseAmountFen: 500,
        shippingFeeFen: 1_300,
        shipmentId: fixture.shipments[0].id,
        totalAmountFen: 1_800,
      }),
      expect.objectContaining({
        merchandiseAmountFen: 700,
        shippingFeeFen: 1_700,
        shipmentId: fixture.shipments[1].id,
        totalAmountFen: 2_400,
      }),
    ]);
  });

  test("releases only the cancelled package duplicate keys for later re-import", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        reason: "取消后需要重新导入该包裹",
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });

    await expect(
      db
        .select({
          deduplicationActive: orderShipments.deduplicationActive,
          id: orderShipments.id,
        })
        .from(orderShipments)
        .where(eq(orderShipments.orderId, fixture.order.id))
        .orderBy(orderShipments.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        { deduplicationActive: false, id: fixture.shipments[0].id },
        { deduplicationActive: true, id: fixture.shipments[1].id },
      ]),
    );
    await expect(
      db
        .select({ deduplicationActive: orderLines.deduplicationActive })
        .from(orderLines)
        .where(eq(orderLines.shipmentId, fixture.shipments[0].id)),
    ).resolves.toEqual([{ deduplicationActive: false }]);
  });

  test("refunds each wallet package once even when cancellation is clicked repeatedly", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "WALLET",
      walletAmountFen: 3_800,
    });

    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "第一次取消",
      shipmentId: fixture.shipments[0].id,
    });
    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        reason: "重复点击取消",
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({ status: "ALREADY_CANCELLED" });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "第二个包裹取消",
      shipmentId: fixture.shipments[1].id,
    });

    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({ totalAmountFen: 1_800, walletAmountFen: 1_800 }),
      expect.objectContaining({ totalAmountFen: 2_000, walletAmountFen: 2_000 }),
    ]);
    await expect(
      db
        .select({ balanceFen: walletAccounts.balanceFen })
        .from(walletAccounts)
        .where(eq(walletAccounts.customerId, fixture.customer.id)),
    ).resolves.toEqual([{ balanceFen: 3_900 }]);
    await expect(
      db
        .select({ deltaFen: walletTransactions.deltaFen })
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_REFUND")),
    ).resolves.toHaveLength(2);
  });

  test("serializes concurrent adjustment creation for the same package", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "WALLET",
      walletAmountFen: 3_800,
    });
    const createAdjustment = () =>
      db.transaction((tx) =>
        recordPackageCancellationAdjustment(tx, {
          actorId: fixture.admin.id,
          actorType: "ADMIN",
          now: new Date("2026-08-20T02:00:00.000Z"),
          orderId: fixture.order.id,
          reason: "并发取消同一包裹",
          shipmentId: fixture.shipments[0].id,
        }),
      );

    const results = await Promise.allSettled([
      createAdjustment(),
      createAdjustment(),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    await expect(refundRows(fixture.order.id)).resolves.toHaveLength(1);
    await expect(
      db
        .select({ deltaFen: walletTransactions.deltaFen })
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_REFUND")),
    ).resolves.toEqual([{ deltaFen: 1_800 }]);
  });

  test("restores the pending-payment lock window after a package cancellation invalidates a pending offline claim", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const declaredAt = new Date("2026-08-20T01:30:00.000Z");
    const cancelledAt = new Date("2026-08-20T02:00:00.000Z");
    const expectedRestoredLock = new Date("2026-08-20T04:00:00.000Z");

    await expect(
      declareOfflinePayment({
        actorUserId: fixture.customer.id,
        amountFen: 3_800,
        customerId: fixture.customer.id,
        now: declaredAt,
        orderId: fixture.order.id,
      }),
    ).resolves.toMatchObject({
      amountFen: 3_800,
      lockExpiresAt: new Date("2026-08-20T13:30:00.000Z"),
      status: "PENDING",
    });

    await db.transaction((tx) =>
      recordPackageCancellationAdjustment(tx, {
        actorId: fixture.admin.id,
        actorType: "ADMIN",
        now: cancelledAt,
        orderId: fixture.order.id,
        reason: "首包取消导致应付金额变更",
        shipmentId: fixture.shipments[0].id,
      }),
    );

    await expect(
      db
        .select({
          lockExpiresAt: fulfillmentOrders.lockExpiresAt,
          paymentDeclaredAt: fulfillmentOrders.paymentDeclaredAt,
        })
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, fixture.order.id)),
    ).resolves.toEqual([
      {
        lockExpiresAt: expectedRestoredLock,
        paymentDeclaredAt: null,
      },
    ]);
    await expect(
      db
        .select({
          expiresAt: inventoryReservations.expiresAt,
          status: inventoryReservations.status,
        })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.referenceId, fixture.order.id)),
    ).resolves.toEqual([
      {
        expiresAt: expectedRestoredLock,
        status: "ACTIVE",
      },
    ]);
    await expect(
      db
        .select({
          rejectionReason: paymentClaims.rejectionReason,
          status: paymentClaims.status,
        })
        .from(paymentClaims)
        .where(eq(paymentClaims.orderId, fixture.order.id)),
    ).resolves.toEqual([
      {
        rejectionReason: "包裹取消后应付金额已变更，请按新金额重新申报",
        status: "REJECTED",
      },
    ]);
  });

  test("splits mixed-payment package refunds cumulatively without rounding loss", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "MIXED",
      walletAmountFen: 1_000,
    });

    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "混合支付首包取消",
      shipmentId: fixture.shipments[0].id,
    });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "混合支付尾包取消",
      shipmentId: fixture.shipments[1].id,
    });

    const refunds = await refundRows(fixture.order.id);
    expect(refunds).toEqual([
      expect.objectContaining({
        offlineAmountFen: 1_327,
        totalAmountFen: 1_800,
        walletAmountFen: 473,
      }),
      expect.objectContaining({
        offlineAmountFen: 1_473,
        totalAmountFen: 2_000,
        walletAmountFen: 527,
      }),
    ]);
    expect(refunds.reduce((sum, row) => sum + row.walletAmountFen, 0)).toBe(1_000);
    expect(refunds.reduce((sum, row) => sum + row.offlineAmountFen, 0)).toBe(2_800);
  });

  test("cancels the remaining collection after a package cancellation without double-refunding", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "WALLET",
      walletAmountFen: 3_800,
    });

    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "先取消首包",
      shipmentId: fixture.shipments[0].id,
    });
    await expect(
      cancelFulfillmentOrder({
        actorType: "CUSTOMER",
        actorUserId: fixture.customer.id,
        customerId: fixture.customer.id,
        orderId: fixture.order.id,
        reason: "再取消整个导出批次",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    const refunds = await refundRows(fixture.order.id);
    expect(refunds).toHaveLength(2);
    expect(refunds.reduce((sum, refund) => sum + refund.totalAmountFen, 0)).toBe(3_800);
    await expect(
      db
        .select({ balanceFen: walletAccounts.balanceFen })
        .from(walletAccounts)
        .where(eq(walletAccounts.customerId, fixture.customer.id)),
    ).resolves.toEqual([{ balanceFen: 3_900 }]);
    await expect(
      db
        .select({ cancellationState: fulfillmentOrders.cancellationState })
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, fixture.order.id)),
    ).resolves.toEqual([{ cancellationState: "ALL" }]);
  });

  test("reduces the payable amount when a package is cancelled before payment", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });

    const originalClaim = await declareOfflinePayment({
      actorUserId: fixture.customer.id,
      amountFen: 3_800,
      customerId: fixture.customer.id,
      now: new Date("2026-08-20T01:30:00.000Z"),
      orderId: fixture.order.id,
    });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "付款前取消首包",
      shipmentId: fixture.shipments[0].id,
    });

    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({
        offlineAmountFen: 0,
        status: "NOT_PAID",
        totalAmountFen: 1_800,
        walletAmountFen: 0,
      }),
    ]);
    await expect(
      db
        .select({ status: paymentClaims.status })
        .from(paymentClaims)
        .where(eq(paymentClaims.id, originalClaim.claimId)),
    ).resolves.toEqual([{ status: "REJECTED" }]);
    await expect(
      declareOfflinePayment({
        actorUserId: fixture.customer.id,
        amountFen: 3_800,
        customerId: fixture.customer.id,
        now: new Date("2026-08-20T02:00:00.000Z"),
        orderId: fixture.order.id,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
    await expect(
      declareOfflinePayment({
        actorUserId: fixture.customer.id,
        amountFen: 2_000,
        customerId: fixture.customer.id,
        now: new Date("2026-08-20T02:00:00.000Z"),
        orderId: fixture.order.id,
      }),
    ).resolves.toMatchObject({ amountFen: 2_000, status: "PENDING" });
  });

  test("invalidates an unpaid unified settlement before cancelling a package", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        reason: "统一结算未完成时取消",
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });
    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({ status: "NOT_PAID", totalAmountFen: 1_800 }),
    ]);
    await expect(
      db
        .select({ status: shipmentFulfillments.status })
        .from(shipmentFulfillments)
        .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id)),
    ).resolves.toEqual([{ status: "CANCELLED" }]);
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "CANCELLED" }]);
  });

  test("invalidates an unpaid unified settlement before cancelling its whole import collection", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });

    await expect(
      cancelFulfillmentOrder({
        actorType: "CUSTOMER",
        actorUserId: fixture.customer.id,
        customerId: fixture.customer.id,
        orderId: fixture.order.id,
        reason: "取消整个店铺导出集合",
      }),
    ).resolves.toEqual({ orderId: fixture.order.id, status: "CANCELLED" });
    await expect(refundRows(fixture.order.id)).resolves.toHaveLength(2);
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "CANCELLED" }]);
  });

  test("keeps an unpaid unified settlement intact when remote cancellation fails", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });
    await db
      .update(shipmentFulfillments)
      .set({
        attemptCount: 1,
        externalOrderNo: "JF-CANCEL-WILL-FAIL",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T02:00:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        client: {
          async cancelOrder() {
            throw new Error("simulated remote cancellation failure");
          },
        },
        reason: "验证远端失败不破坏结算",
        shipmentId: fixture.shipments[0].id,
      }),
    ).rejects.toThrow();
    await expect(refundRows(fixture.order.id)).resolves.toEqual([]);
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "PENDING_PAYMENT" }]);
  });

  test("rejects payment reporting while remote package cancellation is in progress", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });
    await db
      .update(shipmentFulfillments)
      .set({
        attemptCount: 1,
        externalOrderNo: "JF-CANCEL-IN-FLIGHT",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T02:00:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    let signalRemoteStarted!: () => void;
    let releaseRemote!: () => void;
    const remoteStarted = new Promise<void>((resolve) => {
      signalRemoteStarted = resolve;
    });
    const remoteReleased = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    const cancellation = cancelJifengShipment({
      actorUserId: fixture.admin.id,
      client: {
        async cancelOrder() {
          signalRemoteStarted();
          await remoteReleased;
          return { data: null, requestId: "cancel-in-flight" };
        },
      },
      reason: "验证取消和付款申报竞态",
      shipmentId: fixture.shipments[0].id,
    });
    await remoteStarted;

    await expect(
      reportSettlementPayment({
        actorUserId: fixture.customer.id,
        amountFen: 3_800,
        customerId: fixture.customer.id,
        now: new Date("2026-08-20T02:01:00.000Z"),
        settlementBatchId: batch.id,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ORDERS_NOT_PENDING" });

    releaseRemote();
    await expect(cancellation).resolves.toEqual({ status: "CANCEL_PENDING" });
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "CANCELLED" }]);
  });

  test("allows a paid unified-settlement package to enter its normal refund path", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        closedAt: new Date("2026-08-20T01:00:00.000Z"),
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paidAt: new Date("2026-08-20T01:00:00.000Z"),
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        status: "PAID",
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });

    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        reason: "已付款统一结算包裹取消退款",
        shipmentId: fixture.shipments[0].id,
      }),
    ).resolves.toEqual({ status: "CANCELLED" });
    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({ status: "PENDING_OFFLINE", totalAmountFen: 1_800 }),
    ]);
  });

  test("cancels every cancellable child while preserving a shipped sibling", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .update(fulfillmentOrders)
      .set({ status: "FULFILLING" })
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    await db
      .update(shipmentFulfillments)
      .set({ jifengStatus: 7, shippedAt: new Date(), status: "SHIPPED" })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));

    await expect(
      cancelAllCancellableOrderShipments({
        actorUserId: fixture.admin.id,
        orderId: fixture.order.id,
        reason: "客户要求取消整张拿货单中仍可取消的包裹",
      }),
    ).resolves.toMatchObject({
      cancelledCount: 1,
      failedCount: 0,
      pendingCount: 0,
      skippedCount: 1,
    });

    const statuses = await db.execute<{ status: string }>(sql`
      select f.status
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      where s.order_id = ${fixture.order.id}
      order by s.external_order_no
    `);
    expect(statuses.map((row) => row.status)).toEqual(["SHIPPED", "CANCELLED"]);
  });

  test("falls back from parent cancellation to fresh package states after fulfillment starts", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .update(shipmentFulfillments)
      .set({
        externalOrderNo: "JF-BOUND-DURING-PARENT-CANCEL",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T01:05:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    const cancelOrder = vi.fn().mockResolvedValue({ data: null });

    await expect(
      cancelAllCancellableOrderShipments({
        actorUserId: fixture.admin.id,
        getClient: async () => ({ cancelOrder }),
        orderId: fixture.order.id,
        reason: "履约启动竞态下取消全部可取消包裹",
      }),
    ).resolves.toMatchObject({
      cancelledCount: 1,
      failedCount: 0,
      pendingCount: 1,
      skippedCount: 0,
    });
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    const statuses = await db.execute<{ status: string }>(sql`
      select f.status
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      where s.order_id = ${fixture.order.id}
      order by s.external_order_no
    `);
    expect(statuses.map((row) => row.status)).toEqual([
      "CANCEL_PENDING",
      "CANCELLED",
    ]);
  });

  test("locally cancels an unqueued sibling when parent cancellation races with Jifeng fulfillment", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .delete(shipmentFulfillments)
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[1].id));
    await db
      .update(shipmentFulfillments)
      .set({
        externalOrderNo: "JF-BOUND-BEFORE-SIBLING-QUEUE",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T01:05:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    let signalRemoteStarted!: () => void;
    let releaseRemote!: () => void;
    const remoteStarted = new Promise<void>((resolve) => {
      signalRemoteStarted = resolve;
    });
    const remoteReleased = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    const cancelOrder = vi.fn(async () => {
      signalRemoteStarted();
      await remoteReleased;
      return { data: null };
    });

    const firstCancellation = cancelAllCancellableOrderShipments({
      actorUserId: fixture.admin.id,
      getClient: async () => ({ cancelOrder }),
      now: new Date("2026-08-20T01:06:00.000Z"),
      orderId: fixture.order.id,
      reason: "履约入队竞态下取消全部可取消包裹",
    });
    await remoteStarted;
    const concurrentCancellation = await cancelAllCancellableOrderShipments({
      actorUserId: fixture.admin.id,
      getClient: async () => ({ cancelOrder }),
      now: new Date("2026-08-20T01:06:30.000Z"),
      orderId: fixture.order.id,
      reason: "重复点击整单取消",
    });
    releaseRemote();
    const firstResult = await firstCancellation;

    const combined = [firstResult, concurrentCancellation].reduce(
      (totals, result) => ({
        cancelledCount: totals.cancelledCount + result.cancelledCount,
        failedCount: totals.failedCount + result.failedCount,
        pendingCount: totals.pendingCount + result.pendingCount,
        skippedCount: totals.skippedCount + result.skippedCount,
      }),
      { cancelledCount: 0, failedCount: 0, pendingCount: 0, skippedCount: 0 },
    );
    expect(combined).toEqual({
      cancelledCount: 1,
      failedCount: 0,
      pendingCount: 1,
      skippedCount: 2,
    });
    expect(cancelOrder).toHaveBeenCalledTimes(1);

    const packageStates = await db.execute<{
      deduplicationActive: boolean;
      externalOrderNo: string;
      fulfillmentStatus: string;
    }>(sql`
      select
        s.external_order_no as "externalOrderNo",
        s.deduplication_active as "deduplicationActive",
        f.status as "fulfillmentStatus"
      from order_shipments s
      inner join shipment_fulfillments f on f.shipment_id = s.id
      where s.order_id = ${fixture.order.id}
      order by s.external_order_no
    `);
    expect(packageStates).toEqual([
      {
        deduplicationActive: true,
        externalOrderNo: fixture.shipments[0].externalOrderNo,
        fulfillmentStatus: "CANCEL_PENDING",
      },
      {
        deduplicationActive: false,
        externalOrderNo: fixture.shipments[1].externalOrderNo,
        fulfillmentStatus: "CANCELLED",
      },
    ]);
    await expect(
      db
        .select({ quantity: inventoryReservations.quantity })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.status, "ACTIVE")),
    ).resolves.toEqual([{ quantity: 1 }]);
    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({
        merchandiseAmountFen: 700,
        offlineAmountFen: 2_000,
        shipmentId: fixture.shipments[1].id,
        shippingFeeFen: 1_300,
        status: "PENDING_OFFLINE",
        totalAmountFen: 2_000,
        walletAmountFen: 0,
      }),
    ]);
    await expect(getAdminOrderDetail(fixture.order.id)).resolves.toMatchObject({
      adjustedAmountFen: 2_000,
      cancellationState: "PARTIAL",
      netAmountFen: 1_800,
    });
    const localCancellationAudits = await db.execute<{ action: string }>(sql`
      select action
      from audit_logs
      where entity_id = ${fixture.shipments[1].id}
        and action in (
          'SHIPMENT_CANCELLATION_ADJUSTMENT_CREATED',
          'SHIPMENT_CANCELLED_BEFORE_SUBMISSION'
        )
      order by action
    `);
    expect(localCancellationAudits.map((row) => row.action)).toEqual([
      "SHIPMENT_CANCELLATION_ADJUSTMENT_CREATED",
      "SHIPMENT_CANCELLED_BEFORE_SUBMISSION",
    ]);
    await expect(refundRows(fixture.order.id)).resolves.toHaveLength(1);
  });

  test("completes all offline refunds atomically and stays idempotent under concurrency", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "批量退款测试取消一",
      shipmentId: fixture.shipments[0].id,
    });
    await cancelJifengShipment({
      actorUserId: fixture.admin.id,
      reason: "批量退款测试取消二",
      shipmentId: fixture.shipments[1].id,
    });

    const results = await Promise.all([
      completeAllOfflineOrderRefunds({
        actorUserId: fixture.admin.id,
        adminUserId: fixture.admin.id,
        note: "微信退款批次 RF-20260825",
        orderId: fixture.order.id,
      }),
      completeAllOfflineOrderRefunds({
        actorUserId: fixture.admin.id,
        adminUserId: fixture.admin.id,
        note: "微信退款批次 RF-20260825",
        orderId: fixture.order.id,
      }),
    ]);

    expect(results.reduce((sum, result) => sum + result.completedCount, 0)).toBe(2);
    expect(results.reduce((sum, result) => sum + result.completedAmountFen, 0)).toBe(3_800);
    await expect(refundRows(fixture.order.id)).resolves.toEqual([
      expect.objectContaining({ status: "COMPLETED" }),
      expect.objectContaining({ status: "COMPLETED" }),
    ]);
    await expect(
      completeAllOfflineOrderRefunds({
        actorUserId: fixture.admin.id,
        adminUserId: fixture.admin.id,
        note: "微信退款批次 RF-20260825",
        orderId: fixture.order.id,
      }),
    ).resolves.toMatchObject({
      completedAmountFen: 0,
      completedCount: 0,
      status: "ALREADY_COMPLETED",
    });
  });

  test("records offline refund obligations even before fulfillment rows are enqueued", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: "DIRECT_OFFLINE",
      walletAmountFen: 0,
    });
    await db
      .delete(shipmentFulfillments)
      .where(sql`${shipmentFulfillments.shipmentId} in (${fixture.shipments[0].id}, ${fixture.shipments[1].id})`);

    await expect(
      cancelFulfillmentOrder({
        actorType: "ADMIN",
        actorUserId: fixture.admin.id,
        orderId: fixture.order.id,
        reason: "履约记录入队前取消",
      }),
    ).resolves.toEqual({ orderId: fixture.order.id, status: "CANCELLED" });
    const adjustments = await refundRows(fixture.order.id);
    expect(adjustments).toHaveLength(2);
    expect(adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "PENDING_OFFLINE", totalAmountFen: 1_800 }),
        expect.objectContaining({ status: "PENDING_OFFLINE", totalAmountFen: 2_000 }),
      ]),
    );
  });

  test("blocks a reported unified payment before calling Jifeng cancellation", async () => {
    const fixture = await createPaidTwoPackageOrder({
      paymentMode: null,
      walletAmountFen: 0,
    });
    const [batch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SET-PR-${crypto.randomUUID().slice(0, 8)}`,
        customerId: fixture.customer.id,
        idempotencyKey: `package-refund-${crypto.randomUUID()}`,
        offlineAmountFen: 3_800,
        paymentDueAt: new Date("2026-08-20T05:00:00.000Z"),
        paymentReportedAt: new Date("2026-08-20T01:55:00.000Z"),
        status: "PAYMENT_REPORTED",
        totalAmountFen: 3_800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: fixture.customer.id,
      offlineAmountFen: 3_800,
      orderId: fixture.order.id,
      settlementBatchId: batch.id,
      totalAmountFen: 3_800,
      walletAmountFen: 0,
    });

    await db
      .update(shipmentFulfillments)
      .set({
        attemptCount: 1,
        externalOrderNo: "JF-ACTIVE-SETTLEMENT",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T02:00:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fixture.fulfillments[0].id));
    let remoteCancellationCalls = 0;
    await expect(
      cancelJifengShipment({
        actorUserId: fixture.admin.id,
        client: {
          async cancelOrder() {
            remoteCancellationCalls += 1;
            return { data: null, requestId: "must-not-call-jifeng" };
          },
        },
        reason: "付款声明核对前禁止远端取消",
        shipmentId: fixture.shipments[0].id,
      }),
    ).rejects.toMatchObject({
      code: "SETTLEMENT_PAYMENT_REPORTED_CANCELLATION_BLOCKED",
    });
    expect(remoteCancellationCalls).toBe(0);
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, batch.id)),
    ).resolves.toEqual([{ status: "PAYMENT_REPORTED" }]);
  });
});
