"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_SUBMIT_ORDER_STATE,
  type SubmitOrderActionState,
} from "@/modules/orders/action-state";

type SubmitAction = (
  previousState: SubmitOrderActionState,
  formData: FormData,
) => Promise<SubmitOrderActionState>;

export function OrderSubmitButton({
  action,
  batchId,
  disabled,
}: {
  action: SubmitAction;
  batchId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_SUBMIT_ORDER_STATE,
  );
  useEffect(() => {
    if (state.status === "success" && state.orderId) {
      router.push(`/portal/orders/${state.orderId}`);
    }
  }, [router, state.orderId, state.status]);

  return (
    <form action={formAction} className="w-full sm:w-auto">
      <input name="batchId" type="hidden" value={batchId} />
      {state.message ? (
        <p
          className={cn(
            "mb-2 max-w-md text-sm sm:text-right",
            state.status === "error" ? "text-danger" : "text-success",
          )}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
      <Button
        className="min-h-11 w-full px-5 sm:w-auto"
        disabled={disabled || pending}
        type="submit"
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />}
        {pending ? "正在提交" : "确认提交拿货单"}
      </Button>
    </form>
  );
}
