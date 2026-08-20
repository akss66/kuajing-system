import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { parseTorontoDateRange } from "@/modules/reports/date-range";
import { getOperationsReport } from "@/modules/reports/query";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export type AdminOperationsDashboard = {
  criticalStockCount: number;
  fulfillmentExceptionCount: number;
  importExceptionCount: number;
  pendingFulfillmentCount: number;
  pendingPaymentReviewCount: number;
  sevenDaySeries: Array<{ date: string; netOrderAmountFen: number; orderCount: number }>;
  todayNetOrderAmountFen: number;
  todayOrderCount: number;
  todayShippedCount: number;
  topSkus: Array<{
    quantity: number;
    revenueFen: number;
    skuCode: string;
    skuId: string;
    skuName: string;
  }>;
  topStores: Array<{
    merchandiseRevenueFen: number;
    orderCount: number;
    storeId: string;
    storeName: string;
  }>;
};

export async function getAdminOperationsDashboard(
  now = new Date(),
): Promise<AdminOperationsDashboard> {
  const sevenDayRange = parseTorontoDateRange({ now });
  const todayRange = parseTorontoDateRange({
    from: sevenDayRange.toDate,
    to: sevenDayRange.toDate,
  });
  const [summaryRows, trendRows, stockCoverage, operations] = await Promise.all([
    db.execute<{
      fulfillmentExceptionCount: number | string;
      importExceptionCount: number | string;
      pendingFulfillmentCount: number | string;
      pendingPaymentReviewCount: number | string;
      todayNetOrderAmountFen: number | string;
      todayOrderCount: number | string;
      todayShippedCount: number | string;
    }>(sql`
      select
        count(*) filter (
          where submitted_at >= ${todayRange.fromUtc.toISOString()}::timestamptz
            and submitted_at < ${todayRange.toExclusiveUtc.toISOString()}::timestamptz
            and status not in ('CANCELLED', 'EXPIRED')
        ) as "todayOrderCount",
        coalesce(sum(total_amount_fen - coalesce((
          select sum(adjustment.total_amount_fen)
          from shipment_cancellation_adjustments adjustment
          where adjustment.order_id = fulfillment_orders.id
        ), 0)) filter (
          where submitted_at >= ${todayRange.fromUtc.toISOString()}::timestamptz
            and submitted_at < ${todayRange.toExclusiveUtc.toISOString()}::timestamptz
            and status not in ('CANCELLED', 'EXPIRED')
        ), 0) as "todayNetOrderAmountFen",
        (
          select count(distinct shipment.order_id)
          from order_shipments shipment
          where shipment.kind = 'NORMAL'
            and shipment.shipped_at >= ${todayRange.fromUtc.toISOString()}::timestamptz
            and shipment.shipped_at < ${todayRange.toExclusiveUtc.toISOString()}::timestamptz
        ) as "todayShippedCount",
        count(*) filter (where status = 'PAID_PENDING_FULFILLMENT') as "pendingFulfillmentCount",
        count(*) filter (where status = 'FULFILLMENT_EXCEPTION') as "fulfillmentExceptionCount",
        (
          (select count(*) from payment_claims where status = 'PENDING') +
          (select count(*) from settlement_payment_claims where status = 'PENDING')
        ) as "pendingPaymentReviewCount",
        (
          select count(*)
          from order_import_batches
          where status = 'PREVIEW'
            and expires_at > ${now.toISOString()}::timestamptz
            and (invalid_rows > 0 or unknown_sku_rows > 0)
        ) as "importExceptionCount"
      from fulfillment_orders
    `),
    db.execute<{
      date: string | Date;
      netOrderAmountFen: number | string;
      orderCount: number | string;
    }>(sql`
      select
        (submitted_at at time zone ${BUSINESS_TIME_ZONE})::date as date,
        count(*) as "orderCount",
        coalesce(sum(total_amount_fen - coalesce((
          select sum(adjustment.total_amount_fen)
          from shipment_cancellation_adjustments adjustment
          where adjustment.order_id = fulfillment_orders.id
        ), 0)), 0) as "netOrderAmountFen"
      from fulfillment_orders
      where submitted_at >= ${sevenDayRange.fromUtc.toISOString()}::timestamptz
        and submitted_at < ${sevenDayRange.toExclusiveUtc.toISOString()}::timestamptz
        and status not in ('CANCELLED', 'EXPIRED')
      group by date
      order by date
    `),
    getStockCoverageReport({ now }),
    getOperationsReport(sevenDayRange),
  ]);
  const summary = summaryRows[0];
  const trendByDate = new Map(
    trendRows.map((row) => {
      const date =
        row.date instanceof Date
          ? row.date.toISOString().slice(0, 10)
          : String(row.date);
      return [
        date,
        {
          netOrderAmountFen: Number(row.netOrderAmountFen),
          orderCount: Number(row.orderCount),
        },
      ] as const;
    }),
  );
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${sevenDayRange.fromDate}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });

  return {
    criticalStockCount: stockCoverage.filter(
      (row) => row.alertLevel === "CRITICAL",
    ).length,
    fulfillmentExceptionCount: Number(summary?.fulfillmentExceptionCount ?? 0),
    importExceptionCount: Number(summary?.importExceptionCount ?? 0),
    pendingFulfillmentCount: Number(summary?.pendingFulfillmentCount ?? 0),
    pendingPaymentReviewCount: Number(summary?.pendingPaymentReviewCount ?? 0),
    sevenDaySeries: dates.map((date) => ({
      date,
      netOrderAmountFen: trendByDate.get(date)?.netOrderAmountFen ?? 0,
      orderCount: trendByDate.get(date)?.orderCount ?? 0,
    })),
    todayNetOrderAmountFen: Number(summary?.todayNetOrderAmountFen ?? 0),
    todayOrderCount: Number(summary?.todayOrderCount ?? 0),
    todayShippedCount: Number(summary?.todayShippedCount ?? 0),
    topSkus: operations.skuSales.slice(0, 5),
    topStores: operations.stores.slice(0, 5).map((store) => ({
      merchandiseRevenueFen: store.revenueFen,
      orderCount: store.orderCount,
      storeId: store.storeId,
      storeName: store.storeName,
    })),
  };
}
