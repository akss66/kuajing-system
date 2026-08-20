import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  bulkImportDrafts,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  orderImportBatches,
  orderLines,
  orderShipments,
  paymentClaims,
  products,
  settlementBatches,
  settlementPaymentClaims,
  skus,
  stores,
  walletAccounts,
  walletHolds,
} from "@/db/schema";
import { getAdminOperationsDashboard } from "@/modules/dashboard/admin-queries";
import { getCustomerTaskDashboard } from "@/modules/dashboard/customer-queries";

const FIXED_NOW = new Date("2026-08-13T14:00:00.000Z");

describe("dashboard queries", () => {
  afterEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table customers, products restart identity cascade",
      ),
    );
  });

  test("uses Toronto midnight for today's exact order sums and seven-day operations", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values({ code: `DASH-${suffix}`, name: "驾驶舱客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: `驾驶舱店铺 ${suffix}` })
      .returning();
    const [product] = await db
      .insert(products)
      .values({ name: "驾驶舱商品" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 200,
        name: "标准款",
        productId: product.id,
        skuCode: `DASH-SKU-${suffix}`,
      })
      .returning();
    await db.insert(inventoryBalances).values({
      skuId: sku.id,
      totalQuantity: 30,
    });

    const [beforeMidnight, atMidnight, , , nextMidnight, paymentReview] =
      await db
        .insert(fulfillmentOrders)
        .values([
          {
            customerId: customer.id,
            orderNumber: `BEFORE-${suffix}`,
            paidAt: new Date("2026-08-13T03:59:59.999Z"),
            paymentMode: "WALLET",
            status: "SHIPPED",
            storeId: store.id,
            submittedAt: new Date("2026-08-13T03:59:59.999Z"),
            totalAmountFen: 1_400,
            totalPackageCount: 1,
            totalQuantity: 7,
          },
          {
            customerId: customer.id,
            orderNumber: `AT-${suffix}`,
            paidAt: new Date("2026-08-13T04:00:00.000Z"),
            paymentMode: "WALLET",
            status: "SHIPPED",
            storeId: store.id,
            submittedAt: new Date("2026-08-13T04:00:00.000Z"),
            totalAmountFen: 2_200,
            totalPackageCount: 1,
            totalQuantity: 4,
          },
          {
            customerId: customer.id,
            orderNumber: `PENDING-FULFILLMENT-${suffix}`,
            paidAt: new Date("2026-08-13T15:00:00.000Z"),
            paymentMode: "DIRECT_OFFLINE",
            status: "PAID_PENDING_FULFILLMENT",
            storeId: store.id,
            submittedAt: new Date("2026-08-13T15:00:00.000Z"),
            totalAmountFen: 3_300,
            totalPackageCount: 1,
            totalQuantity: 3,
          },
          {
            customerId: customer.id,
            orderNumber: `EXCEPTION-${suffix}`,
            paidAt: new Date("2026-08-13T16:00:00.000Z"),
            paymentMode: "DIRECT_OFFLINE",
            status: "FULFILLMENT_EXCEPTION",
            storeId: store.id,
            submittedAt: new Date("2026-08-13T16:00:00.000Z"),
            totalAmountFen: 500,
            totalPackageCount: 1,
            totalQuantity: 1,
          },
          {
            customerId: customer.id,
            orderNumber: `NEXT-${suffix}`,
            paidAt: new Date("2026-08-14T04:00:00.000Z"),
            paymentMode: "WALLET",
            status: "SHIPPED",
            storeId: store.id,
            submittedAt: new Date("2026-08-14T04:00:00.000Z"),
            totalAmountFen: 4_400,
            totalPackageCount: 1,
            totalQuantity: 4,
          },
          {
            customerId: customer.id,
            lockExpiresAt: new Date("2026-08-02T00:00:00.000Z"),
            orderNumber: `PAYMENT-REVIEW-${suffix}`,
            status: "PENDING_PAYMENT",
            storeId: store.id,
            submittedAt: new Date("2026-08-01T12:00:00.000Z"),
            totalAmountFen: 600,
            totalPackageCount: 1,
            totalQuantity: 1,
          },
        ])
        .returning();

    const [beforeShipment, todayShipment, nextShipment] = await db
      .insert(orderShipments)
      .values([
        {
          externalOrderNo: `SHIP-BEFORE-${suffix}`,
          orderId: beforeMidnight.id,
          recipientPayloadEncrypted: "encrypted",
          shippedAt: new Date("2026-08-13T03:59:59.999Z"),
          storeId: store.id,
        },
        {
          externalOrderNo: `SHIP-TODAY-${suffix}`,
          orderId: atMidnight.id,
          recipientPayloadEncrypted: "encrypted",
          shippedAt: new Date("2026-08-13T05:00:00.000Z"),
          storeId: store.id,
        },
        {
          externalOrderNo: `SHIP-NEXT-${suffix}`,
          orderId: nextMidnight.id,
          recipientPayloadEncrypted: "encrypted",
          shippedAt: new Date("2026-08-14T04:00:00.000Z"),
          storeId: store.id,
        },
      ])
      .returning();
    await db.insert(orderLines).values([
      {
        lineAmountFen: 1_400,
        orderId: beforeMidnight.id,
        quantity: 7,
        shipmentId: beforeShipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: "驾驶舱商品 · 标准款",
        storeId: store.id,
        unitPriceFen: 200,
      },
      {
        lineAmountFen: 2_200,
        orderId: atMidnight.id,
        quantity: 4,
        shipmentId: todayShipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: "驾驶舱商品 · 标准款",
        storeId: store.id,
        unitPriceFen: 550,
      },
      {
        lineAmountFen: 4_400,
        orderId: nextMidnight.id,
        quantity: 4,
        shipmentId: nextShipment.id,
        skuCodeSnapshot: sku.skuCode,
        skuId: sku.id,
        skuNameSnapshot: "驾驶舱商品 · 标准款",
        storeId: store.id,
        unitPriceFen: 1_100,
      },
    ]);
    await db.insert(paymentClaims).values({
      amountFen: 600,
      customerId: customer.id,
      orderId: paymentReview.id,
      status: "PENDING",
    });
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `SETTLEMENT-${suffix}`,
        customerId: customer.id,
        idempotencyKey: `dashboard:${suffix}`,
        offlineAmountFen: 900,
        paymentDueAt: new Date("2026-08-15T04:00:00.000Z"),
        paymentReportedAt: new Date("2026-08-13T12:00:00.000Z"),
        status: "PAYMENT_REPORTED",
        totalAmountFen: 900,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementPaymentClaims).values({
      amountFen: 900,
      customerId: customer.id,
      settlementBatchId: settlement.id,
      status: "PENDING",
    });
    await db.insert(orderImportBatches).values([
      {
        customerId: customer.id,
        expiresAt: new Date("2026-08-14T00:00:00.000Z"),
        fileSha256: "a".repeat(64),
        fileSizeBytes: 1_024,
        invalidRows: 2,
        originalFileName: "needs-review.xlsx",
        readyRows: 3,
        status: "PREVIEW",
        storeId: store.id,
        totalRows: 5,
      },
      {
        customerId: customer.id,
        expiresAt: new Date("2026-08-14T00:00:00.000Z"),
        fileSha256: "b".repeat(64),
        fileSizeBytes: 1_024,
        invalidRows: 2,
        originalFileName: "already-submitted.xlsx",
        readyRows: 3,
        status: "SUBMITTED",
        storeId: store.id,
        submittedAt: new Date("2026-08-13T10:00:00.000Z"),
        totalRows: 5,
      },
      {
        customerId: customer.id,
        expiresAt: new Date("2026-08-13T13:59:59.999Z"),
        fileSha256: "c".repeat(64),
        fileSizeBytes: 1_024,
        originalFileName: "expired-needs-review.xlsx",
        readyRows: 3,
        status: "PREVIEW",
        storeId: store.id,
        totalRows: 5,
        unknownSkuRows: 2,
      },
    ]);

    const dashboard = await getAdminOperationsDashboard(FIXED_NOW);

    expect(dashboard).toMatchObject({
      criticalStockCount: 1,
      fulfillmentExceptionCount: 1,
      importExceptionCount: 1,
      pendingFulfillmentCount: 1,
      pendingPaymentReviewCount: 2,
      todayGmvFen: 6_000,
      todayOrderCount: 3,
      todayShippedCount: 1,
    });
    expect(dashboard.sevenDaySeries).toEqual([
      { date: "2026-08-07", gmvFen: 0, orderCount: 0 },
      { date: "2026-08-08", gmvFen: 0, orderCount: 0 },
      { date: "2026-08-09", gmvFen: 0, orderCount: 0 },
      { date: "2026-08-10", gmvFen: 0, orderCount: 0 },
      { date: "2026-08-11", gmvFen: 0, orderCount: 0 },
      { date: "2026-08-12", gmvFen: 1_400, orderCount: 1 },
      { date: "2026-08-13", gmvFen: 6_000, orderCount: 3 },
    ]);
    expect(dashboard.topSkus).toEqual([
      expect.objectContaining({
        quantity: 11,
        revenueFen: 3_600,
        skuCode: sku.skuCode,
      }),
    ]);
    expect(dashboard.topStores).toEqual([
      expect.objectContaining({
        gmvFen: 3_600,
        orderCount: 2,
        storeName: store.name,
      }),
    ]);
  });

  test("isolates customer tasks, money and store summaries by customer", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer, otherCustomer] = await db
      .insert(customers)
      .values([
        { code: `TASK-${suffix}`, name: "任务客户" },
        { code: `OTHER-${suffix}`, name: "其他客户" },
      ])
      .returning();
    const [mainStore, quietStore, , otherStore] = await db
      .insert(stores)
      .values([
        { customerId: customer.id, name: `主店 ${suffix}` },
        { customerId: customer.id, name: `次店 ${suffix}` },
        { customerId: customer.id, name: `停用店 ${suffix}`, status: "DISABLED" },
        { customerId: otherCustomer.id, name: `其他店 ${suffix}` },
      ])
      .returning();
    await db.insert(walletAccounts).values([
      { balanceFen: 10_000, customerId: customer.id },
      { balanceFen: 99_999, customerId: otherCustomer.id },
    ]);

    const [pendingOrder, reportedOrder, exceptionOrder] = await db
      .insert(fulfillmentOrders)
      .values([
        {
          customerId: customer.id,
          lockExpiresAt: new Date("2026-08-14T00:00:00.000Z"),
          orderNumber: `PENDING-${suffix}`,
          status: "PENDING_PAYMENT",
          storeId: mainStore.id,
          submittedAt: new Date("2026-08-13T04:00:00.000Z"),
          totalAmountFen: 1_234,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          customerId: customer.id,
          lockExpiresAt: new Date("2026-08-14T00:00:00.000Z"),
          orderNumber: `REPORTED-${suffix}`,
          paymentDeclaredAt: new Date("2026-08-13T06:00:00.000Z"),
          status: "PENDING_PAYMENT",
          storeId: mainStore.id,
          submittedAt: new Date("2026-08-13T05:00:00.000Z"),
          totalAmountFen: 5_000,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          customerId: customer.id,
          orderNumber: `TASK-EXCEPTION-${suffix}`,
          paidAt: new Date("2026-08-13T07:00:00.000Z"),
          paymentMode: "WALLET",
          status: "FULFILLMENT_EXCEPTION",
          storeId: mainStore.id,
          submittedAt: new Date("2026-08-13T07:00:00.000Z"),
          totalAmountFen: 2_000,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          cancelledAt: new Date("2026-08-13T08:00:00.000Z"),
          cancelReason: "测试取消，不计入有效订单",
          customerId: customer.id,
          orderNumber: `TASK-CANCELLED-${suffix}`,
          status: "CANCELLED",
          storeId: mainStore.id,
          submittedAt: new Date("2026-08-13T07:30:00.000Z"),
          totalAmountFen: 99_999,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
        {
          customerId: otherCustomer.id,
          lockExpiresAt: new Date("2026-08-14T00:00:00.000Z"),
          orderNumber: `OTHER-PENDING-${suffix}`,
          status: "PENDING_PAYMENT",
          storeId: otherStore.id,
          submittedAt: new Date("2026-08-13T08:00:00.000Z"),
          totalAmountFen: 88_888,
          totalPackageCount: 1,
          totalQuantity: 1,
        },
      ])
      .returning();
    await db.insert(paymentClaims).values({
      amountFen: 5_000,
      customerId: customer.id,
      orderId: reportedOrder.id,
      status: "PENDING",
    });

    const [reportedSettlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `TASK-SETTLEMENT-${suffix}`,
        customerId: customer.id,
        idempotencyKey: `task-dashboard:${suffix}`,
        offlineAmountFen: 400,
        paymentDueAt: new Date("2026-08-14T00:00:00.000Z"),
        paymentReportedAt: new Date("2026-08-13T09:00:00.000Z"),
        status: "PAYMENT_REPORTED",
        totalAmountFen: 500,
        walletAmountFen: 100,
      })
      .returning();
    await db.insert(settlementPaymentClaims).values({
      amountFen: 400,
      customerId: customer.id,
      settlementBatchId: reportedSettlement.id,
      status: "PENDING",
    });
    await db.insert(walletHolds).values([
      {
        amountFen: 200,
        customerId: customer.id,
        settlementBatchId: reportedSettlement.id,
        status: "ACTIVE",
      },
      {
        amountFen: 900,
        customerId: customer.id,
        releaseReason: "已释放",
        releasedAt: new Date("2026-08-13T10:00:00.000Z"),
        settlementBatchId: reportedSettlement.id,
        status: "RELEASED",
      },
    ]);

    const [, latestDraft] = await db
      .insert(bulkImportDrafts)
      .values([
        {
          customerId: customer.id,
          expiresAt: new Date("2026-08-15T00:00:00.000Z"),
          status: "DRAFT",
          updatedAt: new Date("2026-08-13T08:00:00.000Z"),
        },
        {
          customerId: customer.id,
          expiresAt: new Date("2026-08-15T00:00:00.000Z"),
          status: "PARTIALLY_SUBMITTED",
          updatedAt: new Date("2026-08-13T12:00:00.000Z"),
        },
        {
          customerId: customer.id,
          expiresAt: new Date("2026-08-15T00:00:00.000Z"),
          status: "COMPLETED",
          updatedAt: new Date("2026-08-13T13:00:00.000Z"),
        },
        {
          customerId: otherCustomer.id,
          expiresAt: new Date("2026-08-15T00:00:00.000Z"),
          status: "DRAFT",
          updatedAt: new Date("2026-08-13T13:30:00.000Z"),
        },
      ])
      .returning();

    const dashboard = await getCustomerTaskDashboard(customer.id, FIXED_NOW);

    expect(dashboard).toMatchObject({
      activeStoreCount: 2,
      fulfillmentExceptionCount: 1,
      pendingPaymentCount: 1,
      pendingPaymentFen: 1_234,
      paymentReportedCount: 2,
      unfinishedDraftCount: 2,
      walletAvailableFen: 9_800,
      walletBalanceFen: 10_000,
      walletHoldFen: 200,
    });
    expect(dashboard.recentStoreSummaries).toEqual([
      {
        fulfillmentExceptionCount: 1,
        pendingPaymentCount: 1,
        pendingPaymentFen: 1_234,
        recentOrderCount: 3,
        storeId: mainStore.id,
        storeName: mainStore.name,
      },
      {
        fulfillmentExceptionCount: 0,
        pendingPaymentCount: 0,
        pendingPaymentFen: 0,
        recentOrderCount: 0,
        storeId: quietStore.id,
        storeName: quietStore.name,
      },
    ]);
    expect(dashboard.primaryContinuationTarget).toEqual({
      href: `/portal/bulk-orders/${latestDraft.id}`,
      kind: "BULK_DRAFT",
      label: "继续批量拿货草稿",
    });

    expect(pendingOrder.customerId).toBe(customer.id);
    expect(exceptionOrder.customerId).toBe(customer.id);
  });

  test("routes payment-reported continuation to the latest pending flow detail", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values({ code: `PAYMENT-FLOW-${suffix}`, name: "付款流客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: `付款流店铺 ${suffix}` })
      .returning();
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `PAYMENT-FLOW-${suffix}`,
        customerId: customer.id,
        idempotencyKey: `payment-flow:${suffix}`,
        offlineAmountFen: 800,
        paymentDueAt: new Date("2026-08-15T04:00:00.000Z"),
        paymentReportedAt: new Date("2026-08-13T10:00:00.000Z"),
        status: "PAYMENT_REPORTED",
        totalAmountFen: 800,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementPaymentClaims).values({
      amountFen: 800,
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      customerId: customer.id,
      settlementBatchId: settlement.id,
      status: "PENDING",
    });

    const settlementOnly = await getCustomerTaskDashboard(customer.id, FIXED_NOW);

    expect(settlementOnly.primaryContinuationTarget).toEqual({
      href: `/portal/settlements/${settlement.id}`,
      kind: "PAYMENT_REPORTED",
      label: `查看结算批次 ${settlement.batchNumber} 的付款确认`,
    });

    const [directOrder] = await db
      .insert(fulfillmentOrders)
      .values({
        customerId: customer.id,
        lockExpiresAt: new Date("2026-08-15T04:00:00.000Z"),
        orderNumber: `DIRECT-FLOW-${suffix}`,
        paymentDeclaredAt: new Date("2026-08-13T11:00:00.000Z"),
        status: "PENDING_PAYMENT",
        storeId: store.id,
        submittedAt: new Date("2026-08-13T09:00:00.000Z"),
        totalAmountFen: 650,
        totalPackageCount: 1,
        totalQuantity: 1,
      })
      .returning();
    await db.insert(paymentClaims).values({
      amountFen: 650,
      createdAt: new Date("2026-08-13T11:00:00.000Z"),
      customerId: customer.id,
      orderId: directOrder.id,
      status: "PENDING",
    });

    const latestDirect = await getCustomerTaskDashboard(customer.id, FIXED_NOW);

    expect(latestDirect.paymentReportedCount).toBe(2);
    expect(latestDirect.primaryContinuationTarget).toEqual({
      href: `/portal/orders/${directOrder.id}`,
      kind: "PAYMENT_REPORTED",
      label: `查看订单 ${directOrder.orderNumber} 的付款确认`,
    });
  });
});
