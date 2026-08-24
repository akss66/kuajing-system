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
      <TableRow aria-label={`Excel 第 ${row.rowNumber} 行`}>
        <TableCell className="text-muted">{row.rowNumber}</TableCell>
        <TableCell className="whitespace-normal">
          <p className="break-all font-semibold text-ink">
            {row.externalOrderNo ?? "无法读取订单号"}
          </p>
          <p className="mt-0.5 break-all text-xs text-muted">
            {row.externalSubOrderNo ?? "—"}
          </p>
        </TableCell>
        <TableCell className="max-w-[26rem] whitespace-normal">
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
        <TableCell className="tabular-nums">
          <p className="font-semibold text-ink">{effectiveQuantity ?? "—"}</p>
          {row.quantity !== null && effectiveQuantity !== row.quantity ? (
            <p className="mt-0.5 text-xs text-muted">原 {row.quantity}</p>
          ) : null}
        </TableCell>
        <TableCell className="tabular-nums text-muted">
          {row.fulfillmentMode === "CUSTOMER_SUPPLIED"
            ? "—"
            : availableQuantity ?? "—"}
        </TableCell>
        <TableCell>
          <Badge className={cn("w-fit gap-1.5", result.className)} variant="outline">
            <ResultIcon aria-hidden="true" className="size-3.5" />
            {result.label}
          </Badge>
        </TableCell>
        <TableCell className="text-right">
          {editable ? (
            <Button
              aria-controls={editorId}
              aria-expanded={expanded}
              aria-label={`${expanded ? "收起" : "修改"} Excel 第 ${row.rowNumber} 行`}
              onClick={() => setExpanded((current) => !current)}
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
        <TableRow aria-label={`Excel 第 ${row.rowNumber} 行编辑器`} id={editorId}>
          <TableCell className="whitespace-normal bg-surface/35 px-4 py-3" colSpan={7}>
            <ImportRowOverrideForm action={action} batchId={batchId} row={row} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
