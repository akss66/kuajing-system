import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  orderLines,
  orderShipments,
  paymentClaims,
  products,
  replacementRequests,
  settlementBatchOrders,
  settlementBatches,
  settlementPaymentClaims,
  shipmentCancellationAdjustments,
  skus,
  stores,
  walletTransactions,
} from "@/db/schema";
import { getOperationsReport } from "@/modules/reports/query";

describe("operations reports", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        integration_attempts,
        integration_outbox,
        shipment_fulfillments,
        replacement_requests,
        payment_claims,
        wallet_transactions,
        order_lines,
        order_shipments,
        fulfillment_orders,
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        stores,
        admin_users,
        customers
      restart identity cascade
    `));
  });

  test("separates shipped sales, replacements, wallet flows, offline payments and receivables", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [admin] = await db
      .insert(adminUsers)
      .values({ displayName: "报表管理员", loginIdentifier: `report-${suffix}@test.local` })
      .returning();
    const [customer] = await db
      .insert(customers)
      .values({ code: `R-${suffix}`, name: "报表客户" })
      .returning();
    const [storeA, storeB] = await db
      .insert(stores)
      .values([
        { customerId: customer.id, name: `店铺 A ${suffix}` },
        { customerId: customer.id, name: `店铺 B ${suffix}` },
      ])
      .returning();
    const [product] = await db.insert(products).values({ name: "报表商品" }).returning();
    const [skuA, skuB] = await db
      .insert(skus)
      .values([
        { defaultUnitPriceFen: 500, name: "蓝色", productId: product.id, skuCode: `R-A-${suffix}` },
        { defaultUnitPriceFen: 700, name: "黑色", productId: product.id, skuCode: `R-B-${suffix}` },
      ])
      .returning();
    const inRange = new Date("2026-08-11T15:00:00.000Z");
    const recipient = "encrypted-recipient";

    const [directOrder, walletOrder, pendingOrder, unshippedOrder, cancelledOfflineOrder] = await db
      .insert(fulfillmentOrders)
      .values([
        {
          customerId: customer.id,
          orderNumber: `R-DIRECT-${suffix}`,
          paidAt: inRange,
          paymentMode: "DIRECT_OFFLINE",
          status: "SHIPPED",
          storeId: storeA.id,
          submittedAt: inRange,
          totalAmountFen: 900,
          totalPackageCount: 1,
          totalQuantity: 2,
        },
        {
          customerId: customer.id,
          orderNumber: `R-WALLET-${suffix}`,
          paidAt: inRange,
          paymentMode: "WALLET",
          status: "SHIPPED",
          storeId: storeB.id,
          submittedAt: inRange,
          totalAmountFen: 700,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          customerId: customer.id,
          lockExpiresAt: new Date("2026-08-12T20:00:00.000Z"),
          orderNumber: `R-PENDING-${suffix}`,
          status: "PENDING_PAYMENT",
          storeId: storeA.id,
          submittedAt: inRange,
          totalAmountFen: 1_200,
          totalPackageCount: 1,
          totalQuantity: 2,
        },
        {
          customerId: customer.id,
          orderNumber: `R-UNSHIPPED-${suffix}`,
          paidAt: inRange,
          paymentMode: "DIRECT_OFFLINE",
          status: "FULFILLING",
          storeId: storeA.id,
          submittedAt: inRange,
          totalAmountFen: 4_500,
          totalPackageCount: 1,
          totalQuantity: 5,
        },
        {
          cancelledAt: inRange,
          cancelReason: "已接单后整单取消",
          cancellationState: "ALL",
          customerId: customer.id,
          orderNumber: `R-CANCELLED-OFFLINE-${suffix}`,
          paidAt: inRange,
          paymentMode: "DIRECT_OFFLINE",
          status: "CANCELLED",
          storeId: storeA.id,
          submittedAt: inRange,
          totalAmountFen: 1_800,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
      ])
      .returning();

    const [directShipment, walletShipment, replacementShipment, unshippedShipment, cancelledOfflineShipment] = await db
      .insert(orderShipments)
      .values([
        { externalOrderNo: `EXT-D-${suffix}`, orderId: directOrder.id, recipientPayloadEncrypted: recipient, shippedAt: inRange, storeId: storeA.id },
        { externalOrderNo: `EXT-W-${suffix}`, orderId: walletOrder.id, recipientPayloadEncrypted: recipient, shippedAt: inRange, storeId: storeB.id },
        { externalOrderNo: `EXT-R-${suffix}`, kind: "REPLACEMENT", orderId: directOrder.id, recipientPayloadEncrypted: recipient, shippedAt: inRange, storeId: storeA.id },
        { externalOrderNo: `EXT-U-${suffix}`, orderId: unshippedOrder.id, recipientPayloadEncrypted: recipient, storeId: storeA.id },
        { externalOrderNo: `EXT-CANCELLED-${suffix}`, orderId: cancelledOfflineOrder.id, recipientPayloadEncrypted: recipient, storeId: storeA.id },
      ])
      .returning();
    await db.insert(orderLines).values([
      { lineAmountFen: 900, orderId: directOrder.id, quantity: 2, shipmentId: directShipment.id, skuCodeSnapshot: skuA.skuCode, skuId: skuA.id, skuNameSnapshot: "报表商品 · 蓝色", storeId: storeA.id, unitPriceFen: 450 },
      { externalSku: "SELLER-REPORT", lineAmountFen: 0, lineKind: "CUSTOMER_SUPPLIED", orderId: directOrder.id, quantity: 5, shipmentId: directShipment.id, skuCodeSnapshot: "SELLER-REPORT", skuId: null, skuNameSnapshot: "客户自有货", storeId: storeA.id, unitPriceFen: 0, unitPriceMilliYuan: 0 },
      { lineAmountFen: 700, orderId: walletOrder.id, quantity: 1, shipmentId: walletShipment.id, skuCodeSnapshot: skuB.skuCode, skuId: skuB.id, skuNameSnapshot: "报表商品 · 黑色", storeId: storeB.id, unitPriceFen: 700 },
      { lineAmountFen: 0, orderId: directOrder.id, quantity: 1, shipmentId: replacementShipment.id, skuCodeSnapshot: skuA.skuCode, skuId: skuA.id, skuNameSnapshot: "报表商品 · 蓝色", storeId: storeA.id, unitPriceFen: 0 },
      { lineAmountFen: 4_500, orderId: unshippedOrder.id, quantity: 5, shipmentId: unshippedShipment.id, skuCodeSnapshot: skuA.skuCode, skuId: skuA.id, skuNameSnapshot: "报表商品 · 蓝色", storeId: storeA.id, unitPriceFen: 900 },
    ]);
    await db.insert(replacementRequests).values({
      createdByAdminUserId: admin.id,
      orderId: directOrder.id,
      originalShipmentId: directShipment.id,
      reason: "运输破损",
      replacementShipmentId: replacementShipment.id,
      status: "SHIPPED",
    });
    await db.insert(paymentClaims).values({
      amountFen: 900,
      customerId: customer.id,
      orderId: directOrder.id,
      reviewedAt: inRange,
      reviewedByAdminUserId: admin.id,
      status: "APPROVED",
    });
    const [pendingMixedSettlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `R-PENDING-MIXED-${suffix}`,
        customerId: customer.id,
        idempotencyKey: `report-pending-mixed:${suffix}`,
        offlineAmountFen: 800,
        paymentDueAt: new Date("2026-08-12T04:00:00.000Z"),
        status: "PENDING_PAYMENT",
        totalAmountFen: 1_200,
        walletAmountFen: 400,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: customer.id,
      offlineAmountFen: 800,
      orderId: pendingOrder.id,
      settlementBatchId: pendingMixedSettlement.id,
      totalAmountFen: 1_200,
      walletAmountFen: 400,
    });
    const [paidSettlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `R-SETTLEMENT-${suffix}`,
        customerId: customer.id,
        idempotencyKey: `report:${suffix}`,
        offlineAmountFen: 600,
        paidAt: inRange,
        paymentDueAt: new Date("2026-08-12T04:00:00.000Z"),
        paymentReportedAt: inRange,
        status: "PAID",
        totalAmountFen: 600,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementPaymentClaims).values({
      amountFen: 600,
      customerId: customer.id,
      reviewedAt: inRange,
      reviewedByAdminUserId: admin.id,
      settlementBatchId: paidSettlement.id,
      status: "APPROVED",
    });
    await db.insert(shipmentCancellationAdjustments).values({
      actorId: admin.id,
      actorType: "ADMIN",
      customerId: customer.id,
      merchandiseAmountFen: 500,
      offlineAmountFen: 1_800,
      offlineCompletedAt: inRange,
      offlineCompletedByAdminUserId: admin.id,
      orderId: cancelledOfflineOrder.id,
      reason: "极风接单后取消，线下退款完成",
      shipmentId: cancelledOfflineShipment.id,
      shippingFeeFen: 1_300,
      status: "COMPLETED",
      totalAmountFen: 1_800,
      walletAmountFen: 0,
    });
    await db.insert(walletTransactions).values([
      { actorType: "ADMIN", afterBalanceFen: 2_000, beforeBalanceFen: 0, customerId: customer.id, deltaFen: 2_000, reason: "充值", transactionType: "ADMIN_CREDIT", createdAt: inRange },
      { actorType: "SYSTEM", afterBalanceFen: 1_300, beforeBalanceFen: 2_000, customerId: customer.id, deltaFen: -700, orderId: walletOrder.id, reason: "订单扣款", transactionType: "ORDER_DEBIT", createdAt: inRange },
      { actorType: "SYSTEM", afterBalanceFen: 2_000, beforeBalanceFen: 1_300, customerId: customer.id, deltaFen: 700, orderId: walletOrder.id, reason: "订单退款", transactionType: "ORDER_REFUND", createdAt: inRange },
      { actorType: "ADMIN", afterBalanceFen: 1_900, beforeBalanceFen: 2_000, customerId: customer.id, deltaFen: -100, reason: "人工扣减", transactionType: "ADMIN_DEBIT", createdAt: inRange },
    ]);

    const report = await getOperationsReport({
      fromUtc: new Date("2026-08-11T04:00:00.000Z"),
      toExclusiveUtc: new Date("2026-08-12T04:00:00.000Z"),
    });

    expect(report.summary).toEqual({
      orderCount: 2,
      packageCount: 2,
      quantity: 3,
      replacementQuantity: 1,
      revenueFen: 1_600,
    });
    expect(report.skuSales).toEqual([
      expect.objectContaining({ quantity: 2, revenueFen: 900, skuCode: skuA.skuCode }),
      expect.objectContaining({ quantity: 1, revenueFen: 700, skuCode: skuB.skuCode }),
    ]);
    expect(report.stores).toEqual([
      expect.objectContaining({ orderCount: 1, packageCount: 1, quantity: 7, revenueFen: 900, storeName: storeA.name }),
      expect.objectContaining({ orderCount: 1, packageCount: 1, quantity: 1, revenueFen: 700, storeName: storeB.name }),
    ]);
    expect(report.replacements).toEqual([{ quantity: 1, reason: "运输破损", requestCount: 1 }]);
    expect(report.funds).toEqual({
      adminCreditsFen: 2_000,
      adminDebitsFen: 100,
      approvedOfflineFen: 1_500,
      completedOfflineRefundsFen: 1_800,
      orderDebitsFen: 700,
      orderRefundsFen: 700,
      pendingReceivableFen: 800,
    });
  });

  test("groups a complete daily trend by Toronto-local shipment date", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customerA, customerB] = await db
      .insert(customers)
      .values([
        { code: `TREND-A-${suffix}`, name: "趋势客户 A" },
        { code: `TREND-B-${suffix}`, name: "趋势客户 B" },
      ])
      .returning();
    const [storeA, storeB] = await db
      .insert(stores)
      .values([
        { customerId: customerA.id, name: `趋势店铺 A ${suffix}` },
        { customerId: customerB.id, name: `趋势店铺 B ${suffix}` },
      ])
      .returning();
    const [product] = await db.insert(products).values({ name: "趋势商品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 100,
        name: "边界款",
        productId: product.id,
        skuCode: `TREND-${suffix}`,
      })
      .returning();
    const shipmentFacts = [
      { amountFen: 100, customerId: customerA.id, shippedAt: new Date("2026-08-10T03:59:59.999Z"), storeId: storeA.id },
      { amountFen: 200, customerId: customerA.id, shippedAt: new Date("2026-08-10T04:00:00.000Z"), storeId: storeA.id },
      { amountFen: 300, customerId: customerB.id, shippedAt: new Date("2026-08-11T03:59:59.999Z"), storeId: storeB.id },
      { amountFen: 400, customerId: customerA.id, shippedAt: new Date("2026-08-11T04:00:00.000Z"), storeId: storeA.id },
      { amountFen: 500, customerId: customerB.id, shippedAt: new Date("2026-08-14T03:59:59.999Z"), storeId: storeB.id },
      { amountFen: 600, customerId: customerB.id, shippedAt: new Date("2026-08-14T04:00:00.000Z"), storeId: storeB.id },
    ];

    for (const [index, fact] of shipmentFacts.entries()) {
      const [order] = await db
        .insert(fulfillmentOrders)
        .values({
          customerId: fact.customerId,
          orderNumber: `TREND-${suffix}-${index}`,
          paidAt: fact.shippedAt,
          paymentMode: "DIRECT_OFFLINE",
          status: "SHIPPED",
          storeId: fact.storeId,
          submittedAt: fact.shippedAt,
          totalAmountFen: fact.amountFen,
          totalPackageCount: 1,
          totalQuantity: 1,
        })
        .returning();
      const [shipment] = await db
        .insert(orderShipments)
        .values({
          externalOrderNo: `TREND-EXT-${suffix}-${index}`,
          orderId: order.id,
          recipientPayloadEncrypted: "encrypted",
          shippedAt: fact.shippedAt,
          storeId: fact.storeId,
        })
        .returning();
      await db.insert(orderLines).values({
        lineAmountFen: fact.amountFen,
        orderId: order.id,
        quantity: 1,
        shipmentId: shipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: `${product.name} · ${sku.name}`,
        storeId: fact.storeId,
        unitPriceFen: fact.amountFen,
      });
    }

    const report = await getOperationsReport({
      fromUtc: new Date("2026-08-10T04:00:00.000Z"),
      toExclusiveUtc: new Date("2026-08-14T04:00:00.000Z"),
    });

    expect(report.trend).toEqual([
      { date: "2026-08-10", orderCount: 2, revenueFen: 500 },
      { date: "2026-08-11", orderCount: 1, revenueFen: 400 },
      { date: "2026-08-12", orderCount: 0, revenueFen: 0 },
      { date: "2026-08-13", orderCount: 1, revenueFen: 500 },
    ]);
  });

  test("uses order net amount after an old settlement allocation becomes terminal", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const submittedAt = new Date("2026-08-11T15:00:00.000Z");
    const [customer] = await db
      .insert(customers)
      .values({ code: `TERM-${suffix}`, name: "终止结算客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: `终止结算店铺 ${suffix}` })
      .returning();
    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        customerId: customer.id,
        lockExpiresAt: new Date("2026-08-12T04:00:00.000Z"),
        orderNumber: `TERM-${suffix}`,
        status: "PENDING_PAYMENT",
        storeId: store.id,
        submittedAt,
        totalAmountFen: 1_200,
        totalPackageCount: 1,
        totalQuantity: 1,
      })
      .returning();
    const [terminalBatch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `TERM-SET-${suffix}`,
        closedAt: submittedAt,
        customerId: customer.id,
        idempotencyKey: `terminal-report:${suffix}`,
        offlineAmountFen: 200,
        paymentDueAt: new Date("2026-08-12T04:00:00.000Z"),
        status: "CANCELLED",
        statusReason: "旧统一结算已失效",
        totalAmountFen: 1_200,
        walletAmountFen: 1_000,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: customer.id,
      offlineAmountFen: 200,
      orderId: order.id,
      settlementBatchId: terminalBatch.id,
      totalAmountFen: 1_200,
      walletAmountFen: 1_000,
    });

    const report = await getOperationsReport({
      fromUtc: new Date("2026-08-11T04:00:00.000Z"),
      toExclusiveUtc: new Date("2026-08-12T04:00:00.000Z"),
    });

    expect(report.funds.pendingReceivableFen).toBe(1_200);
  });
});
