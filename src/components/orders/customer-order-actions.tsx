import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Input } from "@/components/ui/input";
import {
  cancelCustomerOrderAction,
  declareOfflinePaymentAction,
} from "@/modules/orders/lifecycle-actions";
import type { CustomerOrderDetail } from "@/modules/orders/queries";

export function CustomerOrderActions({ order }: { order: CustomerOrderDetail }) {
  const claimPending = order.latestPaymentClaim?.status === "PENDING";
  const canDeclarePayment = order.status === "PENDING_PAYMENT" && !claimPending;
  const canCancel = ["PENDING_PAYMENT", "PAID_PENDING_FULFILLMENT"].includes(
    order.status,
  );

  return (
    <>
      {canDeclarePayment ? (
        <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
          <h2 className="font-semibold text-ink">申报微信付款</h2>
          <p className="mt-1 text-sm text-muted">提交后库存锁定会延长至 12 小时，等待管理员核对微信收款。</p>
          <ActionForm
            action={declareOfflinePaymentAction}
            className="mt-4 grid gap-4 sm:grid-cols-[0.7fr_1.5fr_auto] sm:items-end"
            submitLabel="我已微信付款"
          >
            <input name="orderId" type="hidden" value={order.id} />
            <label className="space-y-2 text-sm font-medium text-ink">
              付款金额（元）
              <Input
                className="min-h-11 tabular-nums"
                defaultValue={(order.totalAmountFen / 100).toFixed(2)}
                inputMode="decimal"
                name="amountYuan"
                required
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              付款备注（选填）
              <Input className="min-h-11" maxLength={500} name="note" placeholder="例如：微信昵称或转账时间" />
            </label>
          </ActionForm>
        </section>
      ) : null}

      {canCancel ? (
        <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
          <h2 className="font-semibold text-ink">取消拿货单</h2>
          <p className="mt-1 text-sm text-muted">取消原因会永久保存；库存立即释放，钱包扣款会原路退回。</p>
          <ConfirmedActionForm
            action={cancelCustomerOrderAction}
            className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
            confirmDescription="取消后库存会立即释放；如本单使用钱包付款，款项会自动退回。取消原因会永久保存。"
            confirmLabel="确认取消拿货单"
            confirmTitle="确定取消这张拿货单？"
            submitLabel="确认取消"
          >
            <input name="orderId" type="hidden" value={order.id} />
            <label className="space-y-2 text-sm font-medium text-ink">
              取消原因
              <Input className="min-h-11" maxLength={1000} name="reason" placeholder="请说明取消原因" required />
            </label>
          </ConfirmedActionForm>
        </section>
      ) : null}
    </>
  );
}
