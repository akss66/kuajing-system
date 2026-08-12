"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";

import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Input } from "@/components/ui/input";
import {
  reportSettlementPaymentAction,
  withdrawSettlementPaymentAction,
} from "@/modules/settlement/actions";
import { INITIAL_ACTION_STATE } from "@/shared/action-state";

function money(fen: number) {
  return (fen / 100).toFixed(2);
}

export function SettlementPaymentForm({
  claimStatus,
  formId = "settlement-payment-form",
  noteInputId = "settlement-payment-note",
  offlineAmountFen,
  settlementBatchId,
}: {
  claimStatus: "APPROVED" | "PENDING" | "REJECTED" | "WITHDRAWN" | null;
  formId?: string;
  noteInputId?: string;
  offlineAmountFen: number;
  settlementBatchId: string;
}) {
  const [state, formAction, pending] = useActionState(
    reportSettlementPaymentAction,
    INITIAL_ACTION_STATE,
  );
  const feedbackRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const withdrawReasonRef = useRef<HTMLInputElement>(null);

  const messages = [...Object.values(state.fieldErrors ?? {}).flat()];
  if (state.message) messages.push(state.message);

  const canReport =
    claimStatus == null || claimStatus === "REJECTED" || claimStatus === "WITHDRAWN";

  useEffect(() => {
    if (state.status !== "error") return;

    if (canReport) {
      noteInputRef.current?.focus();
      return;
    }

    if (withdrawReasonRef.current) {
      withdrawReasonRef.current.focus();
    } else {
      feedbackRef.current?.focus();
    }
  }, [canReport, state.status]);

  return (
    <div className="space-y-4" id={formId} tabIndex={-1}>
      {canReport ? (
        <form action={formAction} className="grid gap-4">
          <input name="settlementBatchId" type="hidden" value={settlementBatchId} />
          <label className="space-y-2 text-sm font-medium text-ink">
            付款金额（元）
            <Input
              aria-readonly="true"
              className="min-h-11 tabular-nums"
              defaultValue={money(offlineAmountFen)}
              name="amountYuan"
              readOnly
            />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            付款备注（选填）
            <Input
              className="min-h-11"
              id={noteInputId}
              maxLength={500}
              name="note"
              placeholder="例如：微信昵称或转账时间"
              ref={noteInputRef}
            />
          </label>
          {messages.length ? (
            <div
              className={`rounded-lg border px-3 py-2 text-sm ${
                state.status === "success"
                  ? "border-success/20 bg-success/5 text-success"
                  : "border-danger/20 bg-danger/5 text-danger"
              }`}
              ref={feedbackRef}
              role={state.status === "error" ? "alert" : "status"}
              tabIndex={-1}
            >
              {messages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}
          <button
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={pending}
            type="submit"
          >
            {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
            {pending ? "正在提交" : "我已微信付款"}
          </button>
        </form>
      ) : null}

      {claimStatus === "PENDING" ? (
        <ConfirmedActionForm
          action={withdrawSettlementPaymentAction}
          className="grid gap-4"
          confirmDescription="撤回后整笔结算会关闭，相关拿货单同步取消，冻结的余额与库存锁定一并释放。"
          confirmLabel="确认撤回"
          confirmTitle="确定撤回这笔统一付款声明？"
          onErrorFocus={() => withdrawReasonRef.current?.focus()}
          submitLabel="撤回整笔声明"
        >
          <input name="settlementBatchId" type="hidden" value={settlementBatchId} />
          <label className="space-y-2 text-sm font-medium text-ink">
            撤回原因
            <Input
              className="min-h-11"
              maxLength={1000}
              name="reason"
              placeholder="请说明撤回整笔声明的原因"
              ref={withdrawReasonRef}
              required
            />
          </label>
        </ConfirmedActionForm>
      ) : null}
    </div>
  );
}
