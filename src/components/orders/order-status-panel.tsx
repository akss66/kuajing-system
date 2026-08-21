import { AlertTriangle, CheckCircle2, Clock3, XCircle } from "lucide-react";

import type { CustomerOrderDetail } from "@/modules/orders/queries";
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

function paidPaymentDescription(order: CustomerOrderDetail) {
  if (order.paymentMode === "MIXED") {
    if (order.walletAmountFen !== null && order.offlineAmountFen !== null) {
      return `余额扣除 ${money(order.walletAmountFen)}，微信确认 ${money(order.offlineAmountFen)}。`;
    }
    return "本单通过余额与微信组合结算，具体分摊请查看统一结算记录。";
  }
  return order.paymentMode === "WALLET"
    ? "客户余额已自动扣除，无需管理员再次确认。"
    : "管理员已确认微信付款到账，本单未经过钱包充值和扣款。";
}

export function OrderStatusPanel({ order }: { order: CustomerOrderDetail }) {
  const paid = ["PAID_PENDING_FULFILLMENT", "FULFILLING", "SHIPPED"].includes(
    order.status,
  );
  const claimPending = order.latestPaymentClaim?.status === "PENDING";
  const claimRejected = order.latestPaymentClaim?.status === "REJECTED";

  if (claimRejected) {
    return (
      <section className="flex gap-3 rounded-[var(--radius-surface)] border border-danger/25 bg-danger/5 p-4 text-danger">
        <XCircle className="mt-0.5 size-5 shrink-0" />
        <div>
          <h2 className="font-semibold">付款声明被拒绝</h2>
          <p className="mt-1 text-sm">
            {order.latestPaymentClaim?.rejectionReason ?? "管理员未填写拒绝原因"}
          </p>
          <p className="mt-2 text-xs">
            库存重新锁定至 {order.lockExpiresAt ? dateTime(order.lockExpiresAt) : "—"}，请核对后重新申报。
          </p>
        </div>
      </section>
    );
  }

  if (claimPending) {
    return (
      <section className="flex gap-3 rounded-[var(--radius-surface)] border border-primary/20 bg-primary-soft p-4 text-primary-hover">
        <Clock3 className="mt-0.5 size-5 shrink-0" />
        <div>
          <h2 className="font-semibold">已声明微信付款，等待管理员核款</h2>
          <p className="mt-1 text-sm">
            申报金额 {money(order.latestPaymentClaim!.amountFen)}，库存锁定至 {order.lockExpiresAt ? dateTime(order.lockExpiresAt) : "—"}。
          </p>
        </div>
      </section>
    );
  }

  if (paid) {
    return (
      <section className="flex gap-3 rounded-[var(--radius-surface)] border border-success/20 bg-success/5 p-4 text-success">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
        <div>
          <h2 className="font-semibold">付款已完成，等待同舟行发货</h2>
          <p className="mt-1 text-sm">{paidPaymentDescription(order)}</p>
        </div>
      </section>
    );
  }

  if (order.status === "PENDING_PAYMENT") {
    return (
      <section className="flex gap-3 rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 p-4 text-warning">
        <Clock3 className="mt-0.5 size-5 shrink-0" />
        <div>
          <h2 className="font-semibold">请通过微信线下支付本单金额</h2>
          <p className="mt-1 text-sm">
            当前库存锁定至 {order.lockExpiresAt ? dateTime(order.lockExpiresAt) : "—"}（渥太华）。
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex gap-3 rounded-[var(--radius-surface)] border border-border bg-surface-muted p-4 text-muted">
      <AlertTriangle className="mt-0.5 size-5 shrink-0" />
      <div>
        <h2 className="font-semibold text-ink">
          {order.status === "CANCELLED" ? "已取消" : order.status === "EXPIRED" ? "已超时" : "履约状态已更新"}
        </h2>
        <p className="mt-1 text-sm">
          {order.cancelReason ? `原因：${order.cancelReason}` : "该拿货单当前不需要继续操作。"}
        </p>
      </div>
    </section>
  );
}
