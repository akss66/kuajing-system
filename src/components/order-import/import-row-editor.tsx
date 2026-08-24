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
import { TableCell, TableRow } from "@/components/ui/table";
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
      className: "border-border bg-background text-muted",
      icon: CircleMinus,
      label: "重复跳过",
    };
  }
  if (result === "ready") {
    if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") {
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
  batchId,
  row,
}: {
  action: ImportRowAction;
  batchId: string;
  row: EditableImportRow;
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
  const finalSku =
    row.fulfillmentMode === "CUSTOMER_SUPPLIED"
      ? row.externalSku ?? "—"
      : row.resolvedSku?.skuCode ?? "待选择";
  const availableQuantity = row.resolvedSku
    ? row.siblingCandidates.find(
        (candidate) => candidate.id === row.resolvedSku?.id,
      )?.availableQuantity
    : undefined;
  const effectiveQuantity = row.effectiveQuantity ?? row.quantity;

  return (
    <>
      <TableRow
        aria-label={`Excel 第 ${row.rowNumber} 行`}
        className="grid grid-cols-2 gap-x-3 gap-y-3 border-b-0 bg-background p-4 hover:!bg-background has-aria-expanded:!bg-background md:table-row md:p-0 md:hover:!bg-muted/40"
      >
        <TableCell className="col-span-2 h-auto p-0 text-xs font-medium text-muted md:table-cell md:h-11 md:w-16 md:px-3 md:py-2 md:font-normal">
          <span className="md:hidden">Excel 第 </span>{row.rowNumber}<span className="md:hidden"> 行</span>
        </TableCell>
        <TableCell className="col-span-2 h-auto whitespace-normal p-0 md:table-cell md:h-11 md:px-3 md:py-2">
          <p className="break-all font-semibold text-ink">
            {row.externalOrderNo ?? "无法读取订单号"}
          </p>
          <p className="mt-0.5 break-all text-xs text-muted">
            {row.externalSubOrderNo ?? "—"}
          </p>
        </TableCell>
        <TableCell className="col-span-2 h-auto max-w-[26rem] whitespace-normal p-0 md:table-cell md:h-11 md:px-3 md:py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-all text-muted">{row.externalSku ?? "—"}</span>
            <span aria-hidden="true" className="text-muted">→</span>
            <span className="break-all font-semibold text-ink">{finalSku}</span>
          </div>
          <p
            className={cn(
              "mt-1 text-xs leading-5",
              row.status === "READY" ? "text-muted" : "text-danger",
            )}
          >
            {importRowExplanation(row)}
          </p>
        </TableCell>
        <TableCell className="h-auto p-0 tabular-nums md:table-cell md:h-11 md:px-3 md:py-2">
          <p className="text-xs text-muted md:hidden">发货数量</p>
          <p className="font-semibold text-ink">{effectiveQuantity ?? "—"}</p>
          {row.quantity !== null && effectiveQuantity !== row.quantity ? (
            <p className="mt-0.5 text-xs text-muted">原 {row.quantity}</p>
          ) : null}
        </TableCell>
        <TableCell className="h-auto p-0 tabular-nums text-muted md:table-cell md:h-11 md:px-3 md:py-2">
          <p className="text-xs text-muted md:hidden">可用库存</p>
          <p>{row.fulfillmentMode === "CUSTOMER_SUPPLIED" ? "—" : availableQuantity ?? "—"}</p>
        </TableCell>
        <TableCell className="h-auto p-0 md:table-cell md:h-11 md:px-3 md:py-2">
          <Badge className={cn("w-fit gap-1.5", result.className)} variant="outline">
            <ResultIcon aria-hidden="true" className="size-3.5" />
            {result.label}
          </Badge>
        </TableCell>
        <TableCell className="h-auto p-0 text-right md:table-cell md:h-11 md:px-3 md:py-2">
          {editable ? (
            <Button
              aria-controls={editorId}
              aria-expanded={expanded}
              aria-label={`${expanded ? "收起" : "修改"} Excel 第 ${row.rowNumber} 行`}
              onClick={() => setExpanded((current) => !current)}
              className="w-full md:w-auto"
              size="sm"
              type="button"
              variant="outline"
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {expanded ? "收起" : "修改"}
            </Button>
          ) : (
            <span className="text-xs text-muted">
              {row.status === "DUPLICATE" ? "无需处理" : "重新上传"}
            </span>
          )}
        </TableCell>
      </TableRow>
      {editable && expanded ? (
        <TableRow
          aria-label={`Excel 第 ${row.rowNumber} 行编辑器`}
          className="block border-t border-border bg-surface/35 md:table-row"
          id={editorId}
        >
          <TableCell className="block h-auto w-full whitespace-normal bg-surface/35 px-4 py-3 md:table-cell" colSpan={7}>
            <ImportRowOverrideForm action={action} batchId={batchId} row={row} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
