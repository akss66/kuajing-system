import { ArrowLeft, Clock3, WalletCards } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { SettlementPaymentForm } from "@/components/settlement/settlement-payment-form";
import { SettlementRegion, SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import {
  getCustomerSettlementBatchStatusLabel,
  getCustomerSettlementClaimStatusLabel,
  getCustomerSettlementOrderStatusLabel,
  getCustomerWalletHoldStatusLabel,
} from "@/modules/settlement/customer-ui-labels";
import { getCustomerSettlementDetail } from "@/modules/settlement/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function CustomerSettlementDetailPage({
  params,
}: {
  params: Promise<{ settlementId: string }>;
}) {
  const principal = await requireCustomer();
  const { settlementId } = await params;
  const detail = await getCustomerSettlementDetail(principal.customerId, settlementId);
  if (!detail) notFound();
  const reportingOpen = detail.status === "PENDING_PAYMENT";

  return (
    <div className="space-y-5">
      <PageHeading
        breadcrumbs={[
          { href: "/portal/settlements", label: "合并付款记录" },
          { label: "本次付款" },
        ]}
        description={`付款编号 ${detail.batchNumber} · 截止 ${dateTime(detail.paymentDueAt)}（渥太华）`}
        title="本次合并付款"
      />

      <p className="text-sm font-medium text-ink">
        {detail.orders.length} 张拿货单合并为一次付款
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover" href="/portal/settlements">
          <ArrowLeft className="size-4" />
          返回合并付款记录
        </Link>
        {reportingOpen ? (
          <a className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-ink transition-colors hover:bg-surface" href="#settlement-payment-form">
            跳到付款声明
          </a>
        ) : null}
        <Badge variant="secondary">{getCustomerSettlementBatchStatusLabel(detail.status)}</Badge>
        <Badge variant="secondary">{`声明：${getCustomerSettlementClaimStatusLabel(detail.claim?.status ?? null)}`}</Badge>
      </div>

      <MetricStrip
        items={[
          { label: "本次总额", value: money(detail.totalAmountFen) },
          { label: "钱包抵扣", value: money(detail.walletAmountFen) },
          { label: "微信待付", tone: detail.offlineAmountFen ? "warning" : "default", value: money(detail.offlineAmountFen) },
          {
            hint: detail.walletHold ? `冻结 ${money(detail.walletHold.amountFen)}` : "当前无冻结",
            label: "冻结状态",
            value: detail.walletHold ? getCustomerWalletHoldStatusLabel(detail.walletHold.status) : "未冻结",
          },
        ]}
        variant="segmented"
      />

      <SettlementWorkspace className="grid gap-6 space-y-0 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,420px)]">
        <div className="space-y-4 xl:order-2">
          <SettlementRegion
            description="表单金额只读，等于当前微信待付；待审核时可撤回整笔声明。"
            kind="review"
            title="付款记录"
          >
            <div className="p-4 sm:p-5">
              <Clock3 aria-hidden="true" className="mb-3 size-4 text-primary" />
              <SettlementPaymentForm
                claimStatus={detail.claim?.status ?? null}
                formId="settlement-payment-form"
                noteInputId="settlement-payment-note"
                offlineAmountFen={detail.offlineAmountFen}
                reportingOpen={reportingOpen}
                settlementBatchId={detail.id}
              />
            </div>

            {detail.claim ? (
            <section className="border-t border-border p-4 sm:p-5">
              <h2 className="font-semibold text-ink">最近一次声明</h2>
              <div className="mt-3 space-y-2 text-sm text-muted">
                <p>{`状态：${getCustomerSettlementClaimStatusLabel(detail.claim.status)}`}</p>
                <p>{`提交时间：${dateTime(detail.claim.createdAt)}（渥太华）`}</p>
                <p>{`声明金额：${money(detail.claim.amountFen)}`}</p>
                {detail.claim.note ? <p>{`备注：${detail.claim.note}`}</p> : null}
                {detail.claim.reviewedAt ? <p>{`审核时间：${dateTime(detail.claim.reviewedAt)}（渥太华）`}</p> : null}
                {detail.claim.rejectionReason ? <p>{`拒绝原因：${detail.claim.rejectionReason}`}</p> : null}
                {detail.claim.withdrawnAt ? <p>{`撤回时间：${dateTime(detail.claim.withdrawnAt)}（渥太华）`}</p> : null}
                {detail.claim.withdrawalReason ? <p>{`撤回原因：${detail.claim.withdrawalReason}`}</p> : null}
              </div>
            </section>
            ) : null}
          </SettlementRegion>
        </div>

        <SettlementRegion
          action={<WalletCards aria-hidden="true" className="size-4 text-primary" />}
          className="xl:order-1"
          description="这些拿货单来自同一次多店铺批量提交，只需支付一次；付款通过后，每张拿货单分别进入待发货。"
          kind="batches"
          title="本次包含的拿货单"
        >
          <div className="divide-y divide-border">
            {detail.orders.map((order) => (
              <article className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5" key={order.orderId}>
                <div>
                  <Link className="inline-flex min-h-11 items-center break-all font-medium text-primary-hover" href={`/portal/orders/${order.orderId}`}>
                    {order.orderNumber}
                  </Link>
                  <p className="mt-1 text-sm text-muted">
                    {`总额 ${money(order.totalAmountFen)} · 钱包 ${money(order.walletAmountFen)} · 微信 ${money(order.offlineAmountFen)}`}
                  </p>
                </div>
                <Badge variant="secondary">{getCustomerSettlementOrderStatusLabel(order.status)}</Badge>
              </article>
            ))}
          </div>
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
