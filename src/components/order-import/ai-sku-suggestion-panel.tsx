"use client";

import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMilliYuan } from "@/modules/catalog/unit-price";

import type {
  AiSkuMatchAction,
  AiSkuMatchActionState,
  AiSkuMatchSuggestion,
} from "./import-row-model";

const INITIAL_STATE: AiSkuMatchActionState = { status: "idle" };
const confidenceLabels = {
  HIGH: "高置信",
  LOW: "低置信",
  MEDIUM: "中置信",
} as const;

export function AiSkuSuggestionPanel({
  action,
  batchId,
  onSelect,
  selectedSkuId,
  suggestion,
}: {
  action: AiSkuMatchAction;
  batchId: string;
  onSelect: (candidate: AiSkuMatchSuggestion["candidates"][number]) => void;
  selectedSkuId: string | null;
  suggestion: AiSkuMatchSuggestion;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <section
      aria-label="DeepSeek 智能建议"
      className="rounded-[var(--radius-control)] border border-primary/20 bg-primary/[0.035] p-3 sm:p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            DeepSeek 智能建议
          </h4>
          <p className="mt-1 text-xs leading-5 text-muted">
            选择只会填入 SKU；仍需点击“保存并校验”，系统才会重新检查价格、库存和销售状态。
          </p>
        </div>
        <form action={formAction} className="shrink-0">
          <input name="batchId" type="hidden" value={batchId} />
          <input name="suggestionId" type="hidden" value={suggestion.id} />
          <Button
            className="min-h-11 w-full sm:w-auto"
            disabled={pending}
            type="submit"
            variant="ghost"
          >
            {pending ? (
              <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            ) : (
              <X aria-hidden="true" />
            )}
            {pending ? "正在记录" : "这些都不合适"}
          </Button>
        </form>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {suggestion.candidates.map((candidate) => {
          const selected = candidate.skuId === selectedSkuId;
          return (
            <button
              aria-label={`使用 ${candidate.skuCode}`}
              aria-pressed={selected}
              className={cn(
                "min-h-11 min-w-0 rounded-xl border bg-white p-3 text-left transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/22 motion-reduce:transition-none",
                selected
                  ? "border-primary ring-2 ring-primary/15"
                  : "border-border hover:border-primary/45 hover:bg-primary/[0.025]",
                !candidate.available && "cursor-not-allowed opacity-55",
              )}
              disabled={!candidate.available}
              key={candidate.skuId}
              onClick={() => onSelect(candidate)}
              type="button"
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0 break-all text-sm font-semibold text-ink">
                  {candidate.skuCode}
                </span>
                {selected ? (
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted">
                {candidate.productName} · {candidate.name}
              </p>
              <p className="mt-1 break-words text-xs text-muted">
                {[candidate.specification, candidate.color, candidate.combination]
                  .filter(Boolean)
                  .join(" · ") || "规格未填写"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{confidenceLabels[candidate.confidence]}</Badge>
                <span className="text-xs font-medium tabular-nums text-ink">
                  {candidate.unitPriceMilliYuan === null
                    ? "价格已失效"
                    : formatMilliYuan(candidate.unitPriceMilliYuan)}
                </span>
                <span className="text-xs tabular-nums text-muted">
                  可售 {candidate.availableQuantity}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">{candidate.reason}</p>
              {!candidate.available ? (
                <p className="mt-1 text-xs font-medium text-danger">候选已失效</p>
              ) : null}
            </button>
          );
        })}
      </div>
      {state.message ? (
        <p
          className={cn(
            "mt-3 text-sm",
            state.status === "error" ? "text-danger" : "text-success",
          )}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
