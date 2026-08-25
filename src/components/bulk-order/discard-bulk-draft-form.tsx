"use client";

import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { discardBulkDraftAction } from "@/modules/bulk-order/actions";

export function DiscardBulkDraftForm({
  compact = false,
  draftId,
  empty = false,
}: {
  compact?: boolean;
  draftId: string;
  empty?: boolean;
}) {
  const label = empty ? "放弃空白上传" : "放弃本次上传";

  return (
    <ConfirmedActionForm
      action={discardBulkDraftAction}
      className={compact ? "inline-flex" : "w-full sm:w-auto"}
      confirmDescription="只会删除这次尚未提交的店铺分组、Excel 预览和校验结果；已经提交的拿货单、付款与历史记录不会受到影响。"
      confirmLabel="确认放弃"
      confirmTitle="放弃这次多店铺上传？"
      submitLabel={label}
      variant="destructive"
    >
      <input name="draftId" type="hidden" value={draftId} />
    </ConfirmedActionForm>
  );
}
