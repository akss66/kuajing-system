"use client";

import {
  CheckCircle2,
  CircleMinus,
  LoaderCircle,
  Save,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type EditableImportRow = {
  id: string;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
  externalOrderNo: string | null;
  externalSubOrderNo: string | null;
  externalSku: string | null;
  quantity: number | null;
  effectiveQuantity: number | null;
  quantityMultiplier: number;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED" | null;
  resolutionMethod: string | null;
  revision: number;
  resolvedSku: { id: string; skuCode: string; name: string } | null;
  siblingCandidates: Array<{
    id: string;
    skuCode: string;
    name: string;
    availableQuantity: number;
  }>;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ImportRowActionState = {
  status: "idle" | "error" | "success";
  message?: string;
};

type ImportRowAction = (
  previousState: ImportRowActionState,
  formData: FormData,
) => Promise<ImportRowActionState>;

const INITIAL_STATE: ImportRowActionState = { status: "idle" };

function resultMeta(row: EditableImportRow) {
  if (row.status === "DUPLICATE") {
    return {
      className: "bg-surface-muted text-muted",
      icon: CircleMinus,
      label: "重复跳过",
    };
  }
  if (row.status === "READY") {
    return {
      className: "bg-success/10 text-success",
      icon: CheckCircle2,
      label: "校验通过",
    };
  }
  return {
    className: "bg-danger/10 text-danger",
    icon: XCircle,
    label: "校验失败",
  };
}

function explanation(row: EditableImportRow) {
  if (row.status === "DUPLICATE") return "该子订单已存在，本次自动跳过且不会重复收费。";
  if (row.status !== "READY") {
    if (row.errorCode === "SKU_UNAVAILABLE") {
      return "对应 SKU 不可用，请选择同系列替代 SKU、手动输入或调整数量。";
    }
    return row.errorMessage ?? "SKU 不存在、已下架或不可售，请重新选择或手动填写。";
  }
  if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") {
    return "客户自有货：商品金额 ¥0，本包裹仍收物流费 ¥13；正常按平台订单号匹配极风。";
  }

  const sku = row.resolvedSku?.skuCode ?? "系统 SKU";
  if (row.resolutionMethod === "MANUAL_OVERRIDE") {
    return `已手动替换为 ${sku}，实际发货 ${row.effectiveQuantity ?? 0} 件。`;
  }
  if (row.quantityMultiplier > 1) {
    return `${row.quantityMultiplier}PCS 已换算为 ${sku}，实际发货 ${row.effectiveQuantity ?? 0} 件。`;
  }
  if (row.resolutionMethod === "NORMALIZED_SUFFIX") {
    return `已忽略平台后缀并自动匹配 ${sku}。`;
  }
  return `已自动匹配 ${sku}，实际发货 ${row.effectiveQuantity ?? row.quantity ?? 0} 件。`;
}

export function ImportRowEditor({
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
  const result = resultMeta(row);
  const ResultIcon = result.icon;
  const editable =
    row.fulfillmentMode !== null &&
    row.status !== "DUPLICATE" &&
    row.status !== "INVALID";
  const systemSkuEditable = row.fulfillmentMode === "SYSTEM_SKU";

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <article
      aria-label={`Excel 第 ${row.rowNumber} 行`}
      className="space-y-4 p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">Excel 第 {row.rowNumber} 行</p>
          <p className="mt-1 break-all text-sm font-semibold text-ink">
            {row.externalOrderNo ?? "无法读取订单号"}
          </p>
          <p className="mt-1 break-all text-xs text-muted">
            子订单号：{row.externalSubOrderNo ?? "—"}
          </p>
        </div>
        <Badge className={cn("w-fit gap-1.5", result.className)} variant="secondary">
          <ResultIcon aria-hidden="true" className="size-3.5" />
          {result.label}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-xs text-muted">原始 SKU</dt>
          <dd className="mt-1 break-all font-medium text-ink">{row.externalSku ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">最终 SKU</dt>
          <dd className="mt-1 break-all font-medium text-ink">
            {row.fulfillmentMode === "CUSTOMER_SUPPLIED"
              ? row.externalSku ?? "—"
              : row.resolvedSku?.skuCode ?? "待选择"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Excel 原数量</dt>
          <dd className="mt-1 tabular-nums text-ink">{row.quantity ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">实际发货数量</dt>
          <dd className="mt-1 tabular-nums text-ink">{row.effectiveQuantity ?? "—"}</dd>
        </div>
      </dl>

      <p
        className={cn(
          "rounded-[var(--radius-control)] px-3 py-2 text-sm",
          row.status === "READY" ? "bg-surface text-muted" : "bg-danger/5 text-danger",
        )}
      >
        {explanation(row)}
      </p>

      {editable ? (
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
                  <select
                    className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18 disabled:opacity-50"
                    disabled={
                      pending ||
                      !row.siblingCandidates.some(
                        (candidate) => candidate.availableQuantity > 0,
                      )
                    }
                    id={`${inputId}-sibling`}
                    onChange={(event) => {
                      if (event.target.value) setSkuCode(event.target.value);
                    }}
                    value={row.siblingCandidates.some((candidate) => candidate.skuCode === skuCode) ? skuCode : ""}
                  >
                    <option value="">{row.siblingCandidates.length ? "选择同系列 SKU" : "暂无同系列可售 SKU"}</option>
                    {row.siblingCandidates.map((candidate) => (
                      <option
                        disabled={candidate.availableQuantity <= 0}
                        key={candidate.id}
                        value={candidate.skuCode}
                      >
                        {candidate.skuCode} · {candidate.name} · 可用库存 {candidate.availableQuantity}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-manual`}>
                    手动填写最终 SKU
                  </label>
                  <Input
                    autoComplete="off"
                    className="mt-1 h-10"
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
                className="mt-1 h-10 tabular-nums"
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
      ) : null}
    </article>
  );
}
