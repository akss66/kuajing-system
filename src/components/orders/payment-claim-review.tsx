"use client";

import { Check, LoaderCircle, X } from "lucide-react";
import { useActionState, useId } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reviewOfflinePaymentAction } from "@/modules/orders/lifecycle-actions";
import { INITIAL_ACTION_STATE, type ActionState } from "@/shared/action-state";

function Feedback({ state }: { state: ActionState }) {
  const messages = [...Object.values(state.fieldErrors ?? {}).flat()];
  if (state.message) messages.push(state.message);
  if (!messages.length) return null;

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        state.status === "success"
          ? "border-success/20 bg-success/5 text-success"
          : "border-danger/20 bg-danger/5 text-danger"
      }`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

export function PaymentClaimReview({
  amountFen,
  claimId,
  orderNumber,
}: {
  amountFen: number;
  claimId: string;
  orderNumber: string;
}) {
  const formKey = useId().replaceAll(":", "");
  const approveFormId = `approve-${formKey}`;
  const rejectFormId = `reject-${formKey}`;
  const rejectionReasonId = `rejection-reason-${formKey}`;
  const [approveState, approveAction, approvePending] = useActionState(
    reviewOfflinePaymentAction,
    INITIAL_ACTION_STATE,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState(
    reviewOfflinePaymentAction,
    INITIAL_ACTION_STATE,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <form action={approveAction} id={approveFormId}>
          <input name="claimId" type="hidden" value={claimId} />
          <input name="decision" type="hidden" value="APPROVE" />
        </form>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="min-h-11 flex-1 px-4" disabled={approvePending} type="button">
              {approvePending ? <LoaderCircle className="animate-spin" /> : <Check />}
              确认已收款
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认这笔微信付款已到账？</AlertDialogTitle>
              <AlertDialogDescription>
                拿货单 {orderNumber} 将直接进入待发货，确认金额为 ¥{(amountFen / 100).toFixed(2)}。该款项不会充值进客户钱包。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">返回检查</AlertDialogCancel>
              <AlertDialogAction className="min-h-11" form={approveFormId} type="submit">
                确认到账
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <form action={rejectAction} className="contents" id={rejectFormId}>
          <input name="claimId" type="hidden" value={claimId} />
          <input name="decision" type="hidden" value="REJECT" />
          <label className="sr-only" htmlFor={rejectionReasonId}>
            拒绝原因
          </label>
          <Input
            className="min-h-11 flex-[1.4]"
            id={rejectionReasonId}
            maxLength={1000}
            name="rejectionReason"
            placeholder="拒绝时必须填写原因"
          />
        </form>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="min-h-11 flex-1 px-4" disabled={rejectPending} type="button" variant="destructive">
              {rejectPending ? <LoaderCircle className="animate-spin" /> : <X />}
              拒绝声明
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>拒绝这笔付款声明？</AlertDialogTitle>
              <AlertDialogDescription>
                系统会把拒绝原因展示给客户，并把库存锁定恢复为 2 小时。请先确认已填写清晰原因。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">返回检查</AlertDialogCancel>
              <AlertDialogAction className="min-h-11" form={rejectFormId} type="submit" variant="destructive">
                确认拒绝
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <Feedback state={approveState} />
      <Feedback state={rejectState} />
    </div>
  );
}
