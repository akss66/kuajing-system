"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleMinus,
  Package,
  XCircle,
} from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  importRowExplanation,
  importRowResult,
  type AiSkuMatchAction,
  type EditableImportRow,
  type ImportRowAction,
} from "./import-row-model";
import { ImportRowOverrideForm } from "./import-row-override-form";

export type { EditableImportRow } from "./import-row-model";

function resultMeta(row: EditableImportRow) {
  const result = importRowResult(row);
  if (result === "duplicate") {
    return {
      className: "border-border bg-background text-muted",
      icon: CircleMinus,
      label: "重复跳过",
    };
  }
  if (result === "ready") {
    const hasSystemSku = row.fulfillmentItems.some(
      (item) => item.fulfillmentMode === "SYSTEM_SKU",
    );
    if (!hasSystemSku) {
      return {
        className: "border-warning/40 bg-warning/5 text-ink",
        icon: Package,
        label: "仅收运费",
      };
    }
    return {
      className: "border-success/35 bg-background text-success",
      icon: CheckCircle2,
      label: "校验通过",
    };
  }
  return {
    className: "border-danger/35 bg-background text-danger",
    icon: XCircle,
    label: "校验失败",
  };
}

export function ImportRowEditor({
  action,
  addItemAction,
  aiRejectAction,
  batchId,
  removeItemAction,
  row,
  updateItemAction,
}: {
  action: ImportRowAction;
  addItemAction: ImportRowAction;
  aiRejectAction?: AiSkuMatchAction;
  batchId: string;
  removeItemAction: ImportRowAction;
  row: EditableImportRow;
  updateItemAction: ImportRowAction;
}) {
  const result = resultMeta(row);
  const ResultIcon = result.icon;
  const editorId = useId();
  const editable =
    row.fulfillmentMode !== null &&
    row.status !== "DUPLICATE" &&
    row.status !== "INVALID";
  const [expanded, setExpanded] = useState(
    editable && importRowResult(row) === "failed",
  );
  const fulfillmentItems = row.fulfillmentItems;

  return (
    <div
      aria-label={`Excel 第 ${row.rowNumber} 行`}
      className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)] transition-shadow hover:shadow-lg"
      role="listitem"
    >
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-600">Excel 第 {row.rowNumber} 行</p>
            <p className="mt-1 break-all text-sm font-semibold text-ink">
              {row.externalOrderNo ?? "无法读取订单号"}
            </p>
            <p className="mt-0.5 break-all text-xs text-slate-600">
              子订单号：{row.externalSubOrderNo ?? "—"}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge className={cn("w-fit gap-1.5", result.className)} variant="outline">
            <ResultIcon aria-hidden="true" className="size-3.5" />
            {result.label}
          </Badge>
          {editable ? (
            <Button
              aria-controls={editorId}
              aria-expanded={expanded}
              aria-label={`${expanded ? "收起" : "修改"} Excel 第 ${row.rowNumber} 行`}
              onClick={() => setExpanded((current) => !current)}
              className="min-h-11"
              type="button"
              variant="outline"
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {expanded ? "收起" : "修改"}
            </Button>
          ) : (
            <span className="text-xs text-slate-600">
              {row.status === "DUPLICATE" ? "无需处理" : "重新上传"}
            </span>
          )}
          </div>
        </div>

        <dl className="mt-4 grid gap-3 rounded-xl bg-slate-50/70 p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,2.2fr)] sm:p-4">
          <div className="min-w-0">
            <dt className="text-xs text-slate-600">原 SKU</dt>
            <dd className="mt-1 break-all text-sm text-ink">{row.externalSku ?? "—"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-600">
              实际发货货品（{fulfillmentItems.length || "待选择"}）
            </dt>
            <dd className="mt-1 space-y-1.5">
              {fulfillmentItems.length ? fulfillmentItems.map((item) => (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm" key={item.id}>
                  <span className="min-w-0 break-all font-semibold text-ink">
                    {item.position}. {item.skuCode}
                  </span>
                  <span className="whitespace-nowrap tabular-nums text-ink">
                    × {item.effectiveQuantity}
                    <span className="ml-2 text-xs text-muted">
                      {item.fulfillmentMode === "SYSTEM_SKU" ? `库存 ${item.availableQuantity ?? "—"}` : "仅运费"}
                    </span>
                  </span>
                </div>
              )) : (
                <span className="text-sm font-semibold text-ink">待选择</span>
              )}
            </dd>
          </div>
        </dl>
        <p className={cn("mt-3 text-xs leading-5", row.status === "READY" ? "text-slate-600" : "text-danger")}>{importRowExplanation(row)}</p>
      </div>
      {editable && expanded ? (
        <div
          aria-label={`Excel 第 ${row.rowNumber} 行编辑器`}
          className="border-t border-slate-100 bg-slate-50/60 px-4 py-4 sm:px-5"
          id={editorId}
          role="region"
        >
          <ImportRowOverrideForm
            action={action}
            addItemAction={addItemAction}
            aiRejectAction={aiRejectAction}
            batchId={batchId}
            removeItemAction={removeItemAction}
            row={row}
            updateItemAction={updateItemAction}
          />
        </div>
      ) : null}
    </div>
  );
}
