"use client";

import { CheckCircle2, CircleMinus, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import {
  importRowExplanation,
  importRowResult,
  type EditableImportRow,
  type ImportRowAction,
} from "./import-row-model";
import { ImportRowOverrideForm } from "./import-row-override-form";

export type { EditableImportRow } from "./import-row-model";

function resultMeta(row: EditableImportRow) {
  const result = importRowResult(row);
  if (result === "duplicate") {
    return {
      className: "bg-surface-muted text-muted",
      icon: CircleMinus,
      label: "重复跳过",
    };
  }
  if (result === "ready") {
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

export function ImportRowEditor({
  action,
  batchId,
  row,
}: {
  action: ImportRowAction;
  batchId: string;
  row: EditableImportRow;
}) {
  const result = resultMeta(row);
  const ResultIcon = result.icon;
  const editable =
    row.fulfillmentMode !== null &&
    row.status !== "DUPLICATE" &&
    row.status !== "INVALID";

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
        {importRowExplanation(row)}
      </p>

      {editable ? (
        <ImportRowOverrideForm action={action} batchId={batchId} row={row} />
      ) : null}
    </article>
  );
}
