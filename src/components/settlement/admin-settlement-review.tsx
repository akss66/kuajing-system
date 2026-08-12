"use client";

import { useRef } from "react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { reviewSettlementPaymentAction } from "@/modules/settlement/actions";
import type { ManagedAction } from "@/shared/action-state";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

type AdminSettlementReviewProps = {
  auditEntries: Array<{
    actionLabel: string;
    actorLabel: string;
    createdAtLabel: string;
    id: string;
    reason: string;
  }>;
  batch: {
    batchNumber: string;
    claimStatusLabel: string;
    customerLabel: string;
    id: string;
    offlineAmountFen: number;
    paidAtLabel: string;
    paymentReportedAtLabel: string;
    reviewable: boolean;
    statusLabel: string;
    totalAmountFen: number;
    walletAmountFen: number;
    walletHoldLabel: string;
  };
  claim: {
    amountFen: number;
    createdAtLabel: string;
    note: string | null;
    statusLabel: string;
  } | null;
  orders: Array<{
    offlineAmountFen: number;
    orderId: string;
    orderNumber: string;
    statusLabel: string;
    storeName: string;
    totalAmountFen: number;
    walletAmountFen: number;
  }>;
  reviewAction?: ManagedAction;
};

export function AdminSettlementReview({
  auditEntries,
  batch,
  claim,
  orders,
  reviewAction = reviewSettlementPaymentAction,
}: AdminSettlementReviewProps) {
  const rejectionRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6">
      <PageHeading
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{batch.statusLabel}</Badge>
            <Badge variant="secondary">{`声明：${batch.claimStatusLabel}`}</Badge>
          </div>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/settlement-batches", label: "统一结算批次" },
          { label: "付款审核" },
        ]}
        description={`${batch.customerLabel} · 批次 ${batch.batchNumber}`}
        title={`统一款项审核 · ${orders.length} 张拿货单`}
      />

      <MetricStrip
        items={[
          { label: "批次总额", value: money(batch.totalAmountFen) },
          { label: "余额冻结", value: money(batch.walletAmountFen) },
          { label: "微信待付", value: money(batch.offlineAmountFen) },
          { label: "冻结状态", value: batch.walletHoldLabel },
        ]}
      />

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader
            description="这里只读展示每张拿货单的总额、余额抵扣和微信待付，不允许改单店分摊或部分确认。"
            title="逐店分摊"
          />
          <div className="divide-y divide-border">
            {orders.map((order) => (
              <article
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={order.orderId}
              >
                <div>
                  <p className="font-medium text-ink">{order.orderNumber}</p>
                  <p className="mt-1 text-sm text-muted">{order.storeName}</p>
                </div>
                <div className="grid gap-1 text-sm text-right">
                  <p className="font-semibold tabular-nums text-ink">
                    {`总额 ${money(order.totalAmountFen)}`}
                  </p>
                  <p className="text-muted">
                    {`余额 ${money(order.walletAmountFen)} · 微信 ${money(order.offlineAmountFen)}`}
                  </p>
                  <p className="text-muted">{order.statusLabel}</p>
                </div>
              </article>
            ))}
          </div>
        </WorkspacePanel>

        <div className="space-y-4">
          <WorkspacePanel className="p-4 sm:p-5">
            <h2 className="font-semibold text-ink">付款声明</h2>
            <div className="mt-3 space-y-2 text-sm text-muted">
              <p>{`状态：${claim?.statusLabel ?? "未声明"}`}</p>
              <p>{`申报时间：${claim?.createdAtLabel ?? "—"}`}</p>
              <p>{`申报金额：${money(claim?.amountFen ?? batch.offlineAmountFen)}`}</p>
              {claim?.note ? <p>{`备注：${claim.note}`}</p> : null}
            </div>
          </WorkspacePanel>

          <WorkspacePanel className="p-4 sm:p-5">
            <h2 className="font-semibold text-ink">审计</h2>
            <div className="mt-3 space-y-3">
              {auditEntries.map((entry) => (
                <article className="rounded-lg bg-surface px-3 py-3" key={entry.id}>
                  <p className="text-sm font-medium text-ink">{entry.actionLabel}</p>
                  <p className="mt-1 text-xs text-muted">
                    {`${entry.actorLabel} · ${entry.createdAtLabel}`}
                  </p>
                  <p className="mt-2 text-sm text-muted">{entry.reason}</p>
                </article>
              ))}
            </div>
          </WorkspacePanel>

          <WorkspacePanel className="space-y-3 p-4 sm:p-5">
            {batch.reviewable ? (
              <>
                <ConfirmedActionForm
                  action={reviewAction}
                  confirmDescription={`确认后将一次性影响 ${orders.length} 张拿货单，相关订单会统一进入待发货。`}
                  confirmLabel="确认到款"
                  confirmTitle="确认这笔统一付款已经到账？"
                  submitLabel="确认已收款"
                >
                  <input name="settlementBatchId" type="hidden" value={batch.id} />
                  <input name="decision" type="hidden" value="APPROVE" />
                </ConfirmedActionForm>

                <ConfirmedActionForm
                  action={reviewAction}
                  className="grid gap-3"
                  confirmDescription={`拒绝后将整批关闭，并同步取消这 ${orders.length} 张拿货单。拒绝原因会写入审计。`}
                  confirmLabel="确认拒绝"
                  confirmTitle="拒绝这笔统一付款声明？"
                  onErrorFocus={() => rejectionRef.current?.focus()}
                  submitLabel="拒绝付款声明"
                >
                  <input name="settlementBatchId" type="hidden" value={batch.id} />
                  <input name="decision" type="hidden" value="REJECT" />
                  <label className="space-y-2 text-sm font-medium text-ink">
                    拒绝原因
                    <Input
                      className="min-h-11"
                      maxLength={1000}
                      name="rejectionReason"
                      placeholder="拒绝统一付款声明必须填写原因"
                      ref={rejectionRef}
                      required
                    />
                  </label>
                </ConfirmedActionForm>
              </>
            ) : (
              <p className="text-sm text-muted">
                {`该结算批次当前为 ${batch.statusLabel}，审核操作已结束。`}
              </p>
            )}
          </WorkspacePanel>
        </div>
      </section>
    </div>
  );
}
