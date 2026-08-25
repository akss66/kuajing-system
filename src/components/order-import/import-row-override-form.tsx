"use client";

import { LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type {
  EditableImportRow,
  ImportRowAction,
  ImportRowActionState,
} from "./import-row-model";

const INITIAL_STATE: ImportRowActionState = { status: "idle" };
const NO_SIBLING_SELECTED = "__none__";

export function ImportRowOverrideForm({
  action,
  batchId,
  row,
}: {
  action: ImportRowAction;
  batchId: string;
  row: EditableImportRow;
}) {
  const router = useRouter();
  const inputId = useId();
  const [skuCode, setSkuCode] = useState(row.resolvedSku?.skuCode ?? "");
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const systemSkuEditable = row.fulfillmentMode === "SYSTEM_SKU";

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <form action={formAction} className="rounded-[var(--radius-control)] border border-border bg-surface/45 p-3">
      <input name="batchId" type="hidden" value={batchId} />
      <input name="rowId" type="hidden" value={row.id} />
      <input name="expectedRevision" type="hidden" value={row.revision} />

      <div
        className={cn(
          "grid gap-3 lg:items-end",
          systemSkuEditable
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto]"
            : "lg:grid-cols-[9rem_auto] lg:justify-end",
        )}
      >
        {systemSkuEditable ? (
          <>
            <div>
              <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-sibling`}>
                同系列替代 SKU
              </label>
              <Select
                disabled={
                  pending ||
                  !row.siblingCandidates.some(
                    (candidate) => candidate.availableQuantity > 0,
                  )
                }
                onValueChange={(value) => {
                  if (value !== NO_SIBLING_SELECTED) setSkuCode(value);
                }}
                value={row.siblingCandidates.some((candidate) => candidate.skuCode === skuCode) ? skuCode : NO_SIBLING_SELECTED}
              >
                <SelectTrigger aria-label="同系列替代 SKU" className="mt-1 min-h-11 w-full" id={`${inputId}-sibling`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value={NO_SIBLING_SELECTED}>
                    {row.siblingCandidates.length ? "选择同系列 SKU" : "暂无同系列可售 SKU"}
                  </SelectItem>
                  {row.siblingCandidates.map((candidate) => (
                    <SelectItem
                      disabled={candidate.availableQuantity <= 0}
                      key={candidate.id}
                      value={candidate.skuCode}
                    >
                      {candidate.skuCode} · {candidate.name} · 可用库存 {candidate.availableQuantity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-manual`}>
                手动填写最终 SKU
              </label>
              <Input
                autoComplete="off"
                className="mt-1 min-h-11 text-base sm:text-sm"
                disabled={pending}
                id={`${inputId}-manual`}
                maxLength={80}
                name="skuCode"
                onChange={(event) => setSkuCode(event.target.value)}
                placeholder="精确输入系统 SKU"
                required
                value={skuCode}
              />
            </div>
          </>
        ) : null}

        <div>
          <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-quantity`}>
            实际发货数量
          </label>
          <Input
            className="mt-1 min-h-11 text-base tabular-nums sm:text-sm"
            defaultValue={row.effectiveQuantity ?? row.quantity ?? 1}
            disabled={pending}
            id={`${inputId}-quantity`}
            max={1_000_000}
            min={1}
            name="effectiveQuantity"
            required
            step={1}
            type="number"
          />
        </div>

        <Button className="h-10 w-full lg:w-auto" disabled={pending} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {pending ? "正在校验" : "保存并校验"}
        </Button>
      </div>

      {state.message ? (
        <p
          className={cn("mt-3 text-sm", state.status === "error" ? "text-danger" : "text-success")}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
