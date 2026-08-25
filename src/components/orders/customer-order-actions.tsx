import { ChevronDown } from "lucide-react";

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
  const usesActiveSettlement = ["PENDING_PAYMENT", "PAYMENT_REPORTED"].includes(
    order.settlementBatchStatus ?? "",
  );
  const canDeclarePayment =
    order.status === "PENDING_PAYMENT" && !claimPending && !usesActiveSettlement;
  const canCancel = ["PENDING_PAYMENT", "PAID_PENDING_FULFILLMENT"].includes(
    order.status,
  );

  if (!canDeclarePayment && !usesActiveSettlement && !canCancel) return null;

  return (
    <section
      aria-label="订单下一步"
      className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"
    >
      {canDeclarePayment ? (
        <div className="p-4 sm:p-5">
          <p className="text-xs font-medium text-primary">当前需要处理</p>
          <h2 className="mt-1 font-semibold text-ink">完成付款</h2>
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
                aria-readonly="true"
                className="min-h-11 bg-surface-muted/55 tabular-nums"
                defaultValue={((order.netAmountFen ?? order.totalAmountFen) / 100).toFixed(2)}
                inputMode="decimal"
                name="amountYuan"
                readOnly
                required
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              付款备注（选填）
              <Input className="min-h-11" maxLength={500} name="note" placeholder="例如：微信昵称或转账时间" />
            </label>
          </ActionForm>
        </div>
      ) : null}

      {order.status === "PENDING_PAYMENT" && usesActiveSettlement ? (
        <div className="p-4 sm:p-5">
          <p className="text-xs font-medium text-primary">当前需要处理</p>
          <h2 className="mt-1 font-semibold text-ink">完成合并付款</h2>
          <p className="mt-1 text-sm text-muted">本单已与其他拿货单合并付款，请在合并付款详情中完成支付。</p>
          {order.settlementBatchId ? (
            <a
              className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary-hover"
              href={`/portal/settlements/${order.settlementBatchId}`}
            >
              查看本次合并付款
            </a>
          ) : null}
        </div>
      ) : null}

      {canCancel ? (
        <details aria-label="其他操作" className="group border-t border-border">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-muted/60 hover:text-ink sm:px-5 [&::-webkit-details-marker]:hidden">
            <span>其他操作</span>
            <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border bg-surface-muted/35 p-4 sm:p-5">
            <h3 className="font-semibold text-ink">取消拿货单</h3>
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
          </div>
        </details>
      ) : null}
    </section>
  );
}
