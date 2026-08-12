import { ArrowLeft, Clock3, WalletCards } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SettlementPaymentForm } from "@/components/settlement/settlement-payment-form";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { getCustomerSettlementDetail } from "@/modules/settlement/queries";
import {
  getCustomerSettlementBatchStatusLabel,
  getCustomerSettlementClaimStatusLabel,
  getCustomerSettlementOrderStatusLabel,
  getCustomerWalletHoldStatusLabel,
} from "@/modules/settlement/customer-ui-labels";
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
  const detail = await getCustomerSettlementDetail(
    principal.customerId,
    settlementId,
  );
  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover"
            href="/portal/orders?status=PENDING_PAYMENT"
          >
            <ArrowLeft className="size-4" />
            返回待付款
          </Link>
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-ink transition-colors hover:bg-surface"
            href="#settlement-payment-form"
          >
            跳到付款声明
          </a>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            统一付款结算
          </h1>
          <Badge variant="secondary">
            {getCustomerSettlementBatchStatusLabel(detail.status)}
          </Badge>
          <Badge variant="secondary">
            {`声明：${getCustomerSettlementClaimStatusLabel(detail.claim?.status ?? null)}`}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-muted">
          {`批次 ${detail.batchNumber} · 付款截止 ${dateTime(detail.paymentDueAt)}（渥太华）`}
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "批次总额", value: money(detail.totalAmountFen) },
          { label: "钱包抵扣", value: money(detail.walletAmountFen) },
          { label: "微信待付", value: money(detail.offlineAmountFen) },
          {
            label: "冻结状态",
            value: detail.walletHold
              ? `${getCustomerWalletHoldStatusLabel(detail.walletHold.status)} · ${money(detail.walletHold.amountFen)}`
              : "未冻结",
          },
        ].map((item) => (
          <article
            className="rounded-[var(--radius-surface)] border border-border bg-background p-4"
            key={item.label}
          >
            <p className="text-sm text-muted">{item.label}</p>
            <p className="mt-3 text-xl font-semibold tabular-nums text-ink">{item.value}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,420px)]">
        <div className="space-y-4 xl:order-2">
          <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Clock3 className="size-4 text-primary" />
              <h2 className="font-semibold text-ink">付款声明</h2>
            </div>
            <p className="mt-1 text-sm text-muted">
              表单金额只读，等于当前微信待付；待审核时可撤回整笔声明。
            </p>

            <div className="mt-4">
              <SettlementPaymentForm
                claimStatus={detail.claim?.status ?? null}
                formId="settlement-payment-form"
                noteInputId="settlement-payment-note"
                offlineAmountFen={detail.offlineAmountFen}
                settlementBatchId={detail.id}
              />
            </div>
          </section>

          {detail.claim ? (
            <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
              <h2 className="font-semibold text-ink">最近一次声明</h2>
              <div className="mt-3 space-y-2 text-sm text-muted">
                <p>{`状态：${getCustomerSettlementClaimStatusLabel(detail.claim.status)}`}</p>
                <p>{`提交时间：${dateTime(detail.claim.createdAt)}（渥太华）`}</p>
                <p>{`声明金额：${money(detail.claim.amountFen)}`}</p>
                {detail.claim.note ? <p>{`备注：${detail.claim.note}`}</p> : null}
                {detail.claim.reviewedAt ? (
                  <p>{`审核时间：${dateTime(detail.claim.reviewedAt)}（渥太华）`}</p>
                ) : null}
                {detail.claim.rejectionReason ? (
                  <p>{`拒绝原因：${detail.claim.rejectionReason}`}</p>
                ) : null}
                {detail.claim.withdrawnAt ? (
                  <p>{`撤回时间：${dateTime(detail.claim.withdrawnAt)}（渥太华）`}</p>
                ) : null}
                {detail.claim.withdrawalReason ? (
                  <p>{`撤回原因：${detail.claim.withdrawalReason}`}</p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background xl:order-1">
          <div className="border-b border-border px-4 py-4 sm:px-5">
            <div className="flex items-center gap-2">
              <WalletCards className="size-4 text-primary" />
              <h2 className="font-semibold text-ink">批次内拿货单</h2>
            </div>
            <p className="mt-1 text-sm text-muted">
              批次内所有成功提交的店铺会在这里集中付款与跟进。
            </p>
          </div>
          <div className="divide-y divide-border">
            {detail.orders.map((order) => (
              <article
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={order.orderId}
              >
                <div>
                  <Link
                    className="font-medium text-primary-hover"
                    href={`/portal/orders/${order.orderId}`}
                  >
                    {order.orderNumber}
                  </Link>
                  <p className="mt-1 text-sm text-muted">
                    {`总额 ${money(order.totalAmountFen)} · 钱包 ${money(order.walletAmountFen)} · 微信 ${money(order.offlineAmountFen)}`}
                  </p>
                </div>
                <Badge variant="secondary">
                  {getCustomerSettlementOrderStatusLabel(order.status)}
                </Badge>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
