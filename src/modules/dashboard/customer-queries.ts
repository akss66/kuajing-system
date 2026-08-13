import { sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { db } from "@/db/client";
import { parseTorontoDateRange } from "@/modules/reports/date-range";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export type CustomerContinuationTarget = {
  href: string;
  kind:
    | "BULK_DRAFT"
    | "FULFILLMENT_EXCEPTION"
    | "PAYMENT_REPORTED"
    | "PENDING_PAYMENT";
  label: string;
};

export type CustomerTaskDashboard = {
  activeStoreCount: number;
  fulfillmentExceptionCount: number;
  pendingPaymentCount: number;
  pendingPaymentFen: number;
  paymentReportedCount: number;
  primaryContinuationTarget: CustomerContinuationTarget | null;
  recentStoreSummaries: Array<{
    fulfillmentExceptionCount: number;
    pendingPaymentCount: number;
    pendingPaymentFen: number;
    recentOrderCount: number;
    storeId: string;
    storeName: string;
  }>;
  unfinishedDraftCount: number;
  walletAvailableFen: number;
  walletBalanceFen: number;
  walletHoldFen: number;
};

export async function getCustomerTaskDashboard(
  customerId: string,
  now = new Date(),
): Promise<CustomerTaskDashboard> {
  const todayRange = parseTorontoDateRange({ now });
  const recentFrom = DateTime.fromISO(todayRange.toDate, {
    zone: BUSINESS_TIME_ZONE,
  })
    .minus({ days: 29 })
    .toISODate()!;
  const recentRange = parseTorontoDateRange({
    from: recentFrom,
    to: todayRange.toDate,
  });
  const [summaryRows, storeRows] = await Promise.all([
    db.execute<{
      activeStoreCount: number | string;
      fulfillmentExceptionCount: number | string;
      latestDraftId: string | null;
      paymentReportedCount: number | string;
      pendingPaymentCount: number | string;
      pendingPaymentFen: number | string;
      unfinishedDraftCount: number | string;
      walletBalanceFen: number | string;
      walletHoldFen: number | string;
    }>(sql`
      select
        (
          select count(*)
          from bulk_import_drafts
          where customer_id = ${customerId}
            and status in ('DRAFT', 'PARTIALLY_SUBMITTED')
        ) as "unfinishedDraftCount",
        (
          select id
          from bulk_import_drafts
          where customer_id = ${customerId}
            and status in ('DRAFT', 'PARTIALLY_SUBMITTED')
          order by updated_at desc, id desc
          limit 1
        ) as "latestDraftId",
        (
          select count(*)
          from fulfillment_orders
          where customer_id = ${customerId}
            and status = 'PENDING_PAYMENT'
            and payment_declared_at is null
        ) as "pendingPaymentCount",
        (
          select coalesce(sum(total_amount_fen), 0)
          from fulfillment_orders
          where customer_id = ${customerId}
            and status = 'PENDING_PAYMENT'
            and payment_declared_at is null
        ) as "pendingPaymentFen",
        (
          (select count(*) from payment_claims where customer_id = ${customerId} and status = 'PENDING') +
          (select count(*) from settlement_payment_claims where customer_id = ${customerId} and status = 'PENDING')
        ) as "paymentReportedCount",
        (
          select count(*)
          from fulfillment_orders
          where customer_id = ${customerId}
            and status = 'FULFILLMENT_EXCEPTION'
        ) as "fulfillmentExceptionCount",
        (
          select count(*)
          from stores
          where customer_id = ${customerId}
            and status = 'ACTIVE'
        ) as "activeStoreCount",
        coalesce((
          select balance_fen
          from wallet_accounts
          where customer_id = ${customerId}
        ), 0) as "walletBalanceFen",
        (
          select coalesce(sum(amount_fen), 0)
          from wallet_holds
          where customer_id = ${customerId}
            and status = 'ACTIVE'
        ) as "walletHoldFen"
    `),
    db.execute<{
      fulfillmentExceptionCount: number | string;
      pendingPaymentCount: number | string;
      pendingPaymentFen: number | string;
      recentOrderCount: number | string;
      storeId: string;
      storeName: string;
    }>(sql`
      select
        store.id as "storeId",
        store.name as "storeName",
        count("order".id) filter (
          where "order".submitted_at >= ${recentRange.fromUtc.toISOString()}::timestamptz
            and "order".submitted_at < ${recentRange.toExclusiveUtc.toISOString()}::timestamptz
        ) as "recentOrderCount",
        count("order".id) filter (
          where "order".status = 'PENDING_PAYMENT'
            and "order".payment_declared_at is null
        ) as "pendingPaymentCount",
        coalesce(sum("order".total_amount_fen) filter (
          where "order".status = 'PENDING_PAYMENT'
            and "order".payment_declared_at is null
        ), 0) as "pendingPaymentFen",
        count("order".id) filter (
          where "order".status = 'FULFILLMENT_EXCEPTION'
        ) as "fulfillmentExceptionCount"
      from stores store
      left join fulfillment_orders "order" on "order".store_id = store.id
      where store.customer_id = ${customerId}
        and store.status = 'ACTIVE'
      group by store.id, store.name
      order by "recentOrderCount" desc, store.name
      limit 5
    `),
  ]);
  const summary = summaryRows[0];
  const unfinishedDraftCount = Number(summary?.unfinishedDraftCount ?? 0);
  const pendingPaymentCount = Number(summary?.pendingPaymentCount ?? 0);
  const paymentReportedCount = Number(summary?.paymentReportedCount ?? 0);
  const fulfillmentExceptionCount = Number(
    summary?.fulfillmentExceptionCount ?? 0,
  );
  const walletBalanceFen = Number(summary?.walletBalanceFen ?? 0);
  const walletHoldFen = Number(summary?.walletHoldFen ?? 0);
  let primaryContinuationTarget: CustomerContinuationTarget | null = null;

  if (unfinishedDraftCount > 0 && summary?.latestDraftId) {
    primaryContinuationTarget = {
      href: `/portal/bulk-orders/${summary.latestDraftId}`,
      kind: "BULK_DRAFT",
      label: "继续批量拿货草稿",
    };
  } else if (pendingPaymentCount > 0) {
    primaryContinuationTarget = {
      href: "/portal/orders?status=PENDING_PAYMENT",
      kind: "PENDING_PAYMENT",
      label: "处理待付款拿货单",
    };
  } else if (paymentReportedCount > 0) {
    primaryContinuationTarget = {
      href: "/portal/orders",
      kind: "PAYMENT_REPORTED",
      label: "查看付款确认进度",
    };
  } else if (fulfillmentExceptionCount > 0) {
    primaryContinuationTarget = {
      href: "/portal/orders",
      kind: "FULFILLMENT_EXCEPTION",
      label: "查看履约异常",
    };
  }

  return {
    activeStoreCount: Number(summary?.activeStoreCount ?? 0),
    fulfillmentExceptionCount,
    pendingPaymentCount,
    pendingPaymentFen: Number(summary?.pendingPaymentFen ?? 0),
    paymentReportedCount,
    primaryContinuationTarget,
    recentStoreSummaries: storeRows.map((store) => ({
      fulfillmentExceptionCount: Number(store.fulfillmentExceptionCount),
      pendingPaymentCount: Number(store.pendingPaymentCount),
      pendingPaymentFen: Number(store.pendingPaymentFen),
      recentOrderCount: Number(store.recentOrderCount),
      storeId: store.storeId,
      storeName: store.storeName,
    })),
    unfinishedDraftCount,
    walletAvailableFen: Math.max(0, walletBalanceFen - walletHoldFen),
    walletBalanceFen,
    walletHoldFen,
  };
}
