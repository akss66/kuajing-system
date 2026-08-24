import { sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { db } from "@/db/client";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import type {
  FundsReport,
  OperationsReport,
  ReplacementReportRow,
  SkuSalesReportRow,
  StoreSalesReportRow,
} from "./types";

type ReportWindow = { fromUtc: Date; toExclusiveUtc: Date };

function number(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

export async function getOperationsReport(window: ReportWindow): Promise<OperationsReport> {
  const [skuRows, storeRows, replacementRows, walletRows, offlineRows, offlineRefundRows, receivableRows, trendRows] =
    await Promise.all([
      db.execute<{
        quantity: number | string;
        revenueFen: number | string;
        skuCode: string;
        skuId: string;
        skuName: string;
      }>(sql`
        select
          ol.sku_id as "skuId",
          max(ol.sku_code_snapshot) as "skuCode",
          max(ol.sku_name_snapshot) as "skuName",
          sum(ol.quantity) as quantity,
          sum(ol.line_amount_fen) as "revenueFen"
        from order_lines ol
        join order_shipments os on os.id = ol.shipment_id
        where os.kind = 'NORMAL'
          and os.shipped_at >= ${window.fromUtc.toISOString()}::timestamptz
          and os.shipped_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
        group by ol.sku_id
        order by sum(ol.quantity) desc, max(ol.sku_code_snapshot)
      `),
      db.execute<{
        orderCount: number | string;
        packageCount: number | string;
        quantity: number | string;
        revenueFen: number | string;
        storeId: string;
        storeName: string;
      }>(sql`
        select
          s.id as "storeId",
          s.name as "storeName",
          count(distinct ol.order_id) as "orderCount",
          count(distinct os.id) as "packageCount",
          sum(ol.quantity) as quantity,
          sum(ol.line_amount_fen) as "revenueFen"
        from order_lines ol
        join order_shipments os on os.id = ol.shipment_id
        join stores s on s.id = ol.store_id
        where os.kind = 'NORMAL'
          and os.shipped_at >= ${window.fromUtc.toISOString()}::timestamptz
          and os.shipped_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
        group by s.id, s.name
        order by sum(ol.quantity) desc, s.name
      `),
      db.execute<{
        quantity: number | string;
        reason: string;
        requestCount: number | string;
      }>(sql`
        select
          rr.reason,
          count(distinct rr.id) as "requestCount",
          sum(ol.quantity) as quantity
        from replacement_requests rr
        join order_shipments os on os.id = rr.replacement_shipment_id
        join order_lines ol on ol.shipment_id = os.id
        where os.kind = 'REPLACEMENT'
          and os.shipped_at >= ${window.fromUtc.toISOString()}::timestamptz
          and os.shipped_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
        group by rr.reason
        order by sum(ol.quantity) desc, rr.reason
      `),
      db.execute<{
        adminCreditsFen: number | string;
        adminDebitsFen: number | string;
        orderDebitsFen: number | string;
        orderRefundsFen: number | string;
      }>(sql`
        select
          coalesce(sum(case when transaction_type = 'ADMIN_CREDIT' then delta_fen else 0 end), 0) as "adminCreditsFen",
          coalesce(sum(case when transaction_type = 'ADMIN_DEBIT' then -delta_fen else 0 end), 0) as "adminDebitsFen",
          coalesce(sum(case when transaction_type = 'ORDER_DEBIT' then -delta_fen else 0 end), 0) as "orderDebitsFen",
          coalesce(sum(case when transaction_type = 'ORDER_REFUND' then delta_fen else 0 end), 0) as "orderRefundsFen"
        from wallet_transactions
        where created_at >= ${window.fromUtc.toISOString()}::timestamptz
          and created_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
      `),
      db.execute<{ approvedOfflineFen: number | string }>(sql`
        select coalesce(sum(approved.amount_fen), 0) as "approvedOfflineFen"
        from (
          select amount_fen, reviewed_at
          from payment_claims
          where status = 'APPROVED'

          union all

          select amount_fen, reviewed_at
          from settlement_payment_claims
          where status = 'APPROVED'
        ) approved
        where approved.reviewed_at >= ${window.fromUtc.toISOString()}::timestamptz
          and approved.reviewed_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
      `),
      db.execute<{ completedOfflineRefundsFen: number | string }>(sql`
        select coalesce(sum(offline_amount_fen), 0) as "completedOfflineRefundsFen"
        from shipment_cancellation_adjustments
        where status = 'COMPLETED'
          and offline_amount_fen > 0
          and offline_completed_at >= ${window.fromUtc.toISOString()}::timestamptz
          and offline_completed_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
      `),
      db.execute<{ pendingReceivableFen: number | string }>(sql`
        select coalesce(sum(
          case
            when active_batch.id is not null then allocation.offline_amount_fen
            else "order".total_amount_fen - coalesce((
              select sum(adjustment.total_amount_fen)
              from shipment_cancellation_adjustments adjustment
              where adjustment.order_id = "order".id
            ), 0)
          end
        ), 0) as "pendingReceivableFen"
        from fulfillment_orders "order"
        left join settlement_batch_orders allocation
          on allocation.order_id = "order".id
        left join settlement_batches active_batch
          on active_batch.id = allocation.settlement_batch_id
          and active_batch.status in ('PENDING_PAYMENT', 'PAYMENT_REPORTED')
        where "order".status = 'PENDING_PAYMENT'
          and "order".submitted_at >= ${window.fromUtc.toISOString()}::timestamptz
          and "order".submitted_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
      `),
      db.execute<{
        date: string | Date;
        orderCount: number | string;
        revenueFen: number | string;
      }>(sql`
        select
          (os.shipped_at at time zone 'America/Toronto')::date as date,
          count(distinct ol.order_id) as "orderCount",
          sum(ol.line_amount_fen) as "revenueFen"
        from order_lines ol
        join order_shipments os on os.id = ol.shipment_id
        where os.kind = 'NORMAL'
          and os.shipped_at >= ${window.fromUtc.toISOString()}::timestamptz
          and os.shipped_at < ${window.toExclusiveUtc.toISOString()}::timestamptz
        group by date
        order by date
      `),
    ]);

  const skuSales: SkuSalesReportRow[] = skuRows.map((row) => ({
    quantity: number(row.quantity),
    revenueFen: number(row.revenueFen),
    skuCode: row.skuCode,
    skuId: row.skuId,
    skuName: row.skuName,
  }));
  const stores: StoreSalesReportRow[] = storeRows.map((row) => ({
    orderCount: number(row.orderCount),
    packageCount: number(row.packageCount),
    quantity: number(row.quantity),
    revenueFen: number(row.revenueFen),
    storeId: row.storeId,
    storeName: row.storeName,
  }));
  const replacements: ReplacementReportRow[] = replacementRows.map((row) => ({
    quantity: number(row.quantity),
    reason: row.reason,
    requestCount: number(row.requestCount),
  }));
  const wallet = walletRows[0];
  const funds: FundsReport = {
    adminCreditsFen: number(wallet?.adminCreditsFen),
    adminDebitsFen: number(wallet?.adminDebitsFen),
    approvedOfflineFen: number(offlineRows[0]?.approvedOfflineFen),
    completedOfflineRefundsFen: number(
      offlineRefundRows[0]?.completedOfflineRefundsFen,
    ),
    orderDebitsFen: number(wallet?.orderDebitsFen),
    orderRefundsFen: number(wallet?.orderRefundsFen),
    pendingReceivableFen: number(receivableRows[0]?.pendingReceivableFen),
  };
  const trendByDate = new Map(
    trendRows.map((row) => [
      row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      {
        orderCount: number(row.orderCount),
        revenueFen: number(row.revenueFen),
      },
    ]),
  );
  const firstTrendDate = DateTime.fromJSDate(window.fromUtc, { zone: "utc" })
    .setZone(BUSINESS_TIME_ZONE)
    .startOf("day");
  const lastTrendDate = DateTime.fromJSDate(window.toExclusiveUtc, { zone: "utc" })
    .minus({ milliseconds: 1 })
    .setZone(BUSINESS_TIME_ZONE)
    .startOf("day");
  const trend: OperationsReport["trend"] = [];
  for (
    let cursor = firstTrendDate;
    cursor.toMillis() <= lastTrendDate.toMillis();
    cursor = cursor.plus({ days: 1 })
  ) {
    const date = cursor.toISODate()!;
    const activity = trendByDate.get(date);
    trend.push({
      date,
      orderCount: activity?.orderCount ?? 0,
      revenueFen: activity?.revenueFen ?? 0,
    });
  }

  return {
    funds,
    replacements,
    skuSales,
    stores,
    trend,
    summary: {
      orderCount: stores.reduce((sum, row) => sum + row.orderCount, 0),
      packageCount: stores.reduce((sum, row) => sum + row.packageCount, 0),
      quantity: skuSales.reduce((sum, row) => sum + row.quantity, 0),
      replacementQuantity: replacements.reduce((sum, row) => sum + row.quantity, 0),
      revenueFen: skuSales.reduce((sum, row) => sum + row.revenueFen, 0),
    },
  };
}
