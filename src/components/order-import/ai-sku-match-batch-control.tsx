"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  AiSkuMatchAction,
  AiSkuMatchActionState,
} from "./import-row-model";

const INITIAL_STATE: AiSkuMatchActionState = { status: "idle" };

export function AiSkuMatchBatchControl({
  action,
  batchId,
  pendingRowCount,
}: {
  action: AiSkuMatchAction;
  batchId: string;
  pendingRowCount: number;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <section
      aria-label="智能 SKU 推荐"
      className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-4 sm:flex sm:items-center sm:justify-between sm:gap-5 sm:p-5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles aria-hidden="true" className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-ink">智能辅助匹配</h3>
            <p className="text-xs text-muted">本次最多处理 20 行，建议不会自动写入订单。</p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted">
          仅发送商品名称、规格和 SKU 信息至 DeepSeek，不发送收件人、地址、联系方式或订单标识。
        </p>
        {state.message ? (
          <p
            className={cn(
              "mt-2 text-sm",
              state.status === "error" ? "text-danger" : "text-success",
            )}
            role={state.status === "error" ? "alert" : "status"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
      <form action={formAction} className="mt-4 shrink-0 sm:mt-0">
        <input name="batchId" type="hidden" value={batchId} />
        <Button
          aria-label="智能推荐待匹配 SKU"
          className="min-h-11 w-full sm:w-auto"
          disabled={pending || pendingRowCount === 0}
          type="submit"
          variant="outline"
        >
          {pending ? (
            <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {pending ? "正在生成建议" : `智能推荐待匹配 SKU（${pendingRowCount}）`}
        </Button>
      </form>
    </section>
  );
}
