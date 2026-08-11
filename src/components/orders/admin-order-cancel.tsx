import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Input } from "@/components/ui/input";
import { cancelAdminOrderAction } from "@/modules/orders/lifecycle-actions";

export function AdminOrderCancel({ orderId }: { orderId: string }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-medium text-danger outline-none focus-visible:ring-3 focus-visible:ring-danger/20">
        取消拿货单
      </summary>
      <ConfirmedActionForm
        action={cancelAdminOrderAction}
        className="mt-2 grid min-w-64 gap-3 rounded-lg border border-danger/20 bg-danger/5 p-3"
        confirmDescription="取消后库存会立即释放；如该单使用钱包付款，款项会自动退回。取消原因会永久写入审计记录。"
        confirmLabel="确认取消拿货单"
        confirmTitle="确定取消这张拿货单？"
        submitLabel="确认取消"
      >
        <input name="orderId" type="hidden" value={orderId} />
        <label className="space-y-2 text-sm font-medium text-ink">
          取消原因
          <Input className="min-h-11 bg-background" maxLength={1000} name="reason" placeholder="必须填写并永久保存" required />
        </label>
      </ConfirmedActionForm>
    </details>
  );
}
