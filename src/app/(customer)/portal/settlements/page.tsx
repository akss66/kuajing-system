import { ArrowRight, WalletCards } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { SettlementRegion, SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { getCustomerSettlementBatchStatusLabel } from "@/modules/settlement/customer-ui-labels";
import { listCustomerSettlementBatches } from "@/modules/settlement/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function CustomerSettlementListPage() {
  const principal = await requireCustomer();
  const batches = await listCustomerSettlementBatches(principal.customerId);
  const pendingCount = batches.filter((batch) => batch.status === "PENDING_PAYMENT").length;
  const reviewingCount = batches.filter((batch) => batch.status === "PAYMENT_REPORTED").length;
  const pendingOfflineFen = batches
    .filter((batch) => batch.status === "PENDING_PAYMENT")
    .reduce((sum, batch) => sum + batch.offlineAmountFen, 0);

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <Link
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-primary transition-colors hover:bg-surface"
            href="/portal/bulk-orders"
          >
            发起批量拿货
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
        description="多店铺批量拿货提交后，每次合并付款都会保留在这里。"
        title="批量付款"
      />

      <MetricStrip
        items={[
          { label: "最近付款", value: String(batches.length) },
          {
            label: "待付款",
            tone: pendingCount ? "warning" : "default",
            value: String(pendingCount),
          },
          {
            hint: "只统计仍需微信补付的付款",
            label: "微信待付",
            tone: pendingOfflineFen ? "warning" : "default",
            value: money(pendingOfflineFen),
          },
          { label: "等待核款", tone: reviewingCount ? "warning" : "default", value: String(reviewingCount) },
        ]}
      />

      <SettlementWorkspace>
        <SettlementRegion
          action={<WalletCards aria-hidden="true" className="size-5 text-primary" />}
          description="每次批量提交只需支付一次；进入详情可付款、查看核款进度和所包含的拿货单。"
          kind="batches"
          title="最近批量付款"
        >
          {batches.length ? (
            <div className="divide-y divide-border">
              {batches.map((batch) => {
                const actionLabel =
                  batch.status === "PENDING_PAYMENT"
                    ? "继续付款"
                    : batch.status === "PAYMENT_REPORTED"
                      ? "查看核款进度"
                      : "查看付款记录";

                return (
                  <article
                    className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    key={batch.id}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-ink">{batch.batchNumber}</p>
                        <Badge variant="secondary">
                          {getCustomerSettlementBatchStatusLabel(batch.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        创建于 {dateTime(batch.createdAt)}（渥太华）
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        截止付款 {dateTime(batch.paymentDueAt)}（渥太华）
                      </p>
                      <p className="mt-3 text-sm text-ink">
                        总额 {money(batch.totalAmountFen)} · 钱包 {money(batch.walletAmountFen)} · 微信待付{" "}
                        {money(batch.offlineAmountFen)}
                      </p>
                    </div>
                    <Link
                      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-primary transition-colors hover:bg-surface"
                      href={`/portal/settlements/${batch.id}`}
                    >
                      {actionLabel}
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Link>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="px-5 py-16 text-center">
              <p className="font-medium text-ink">暂无批量付款记录</p>
              <p className="mt-1 text-sm text-muted">提交多店铺批量拿货后，会在这里保留付款历史与状态。</p>
            </div>
          )}
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
