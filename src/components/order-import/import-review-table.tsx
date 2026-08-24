"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { ImportRowEditor } from "./import-row-editor";
import {
  importRowResult,
  type EditableImportRow,
  type ImportRowAction,
} from "./import-row-model";

function uniquePackageCount(rows: readonly EditableImportRow[]) {
  return new Set(
    rows
      .filter((row) => row.status === "READY")
      .map((row) => row.externalOrderNo)
      .filter((value): value is string => Boolean(value)),
  ).size;
}

export function ImportReviewTable({
  action,
  batchId,
  rows,
}: {
  action: ImportRowAction;
  batchId: string;
  rows: EditableImportRow[];
}) {
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState(false);
  const attentionCount = rows.filter((row) => importRowResult(row) === "failed").length;
  const readyRows = rows.filter((row) => row.status === "READY");
  const visibleRows = onlyNeedsAttention
    ? rows.filter((row) => importRowResult(row) === "failed")
    : rows;
  const quantity = readyRows.reduce(
    (total, row) => total + (row.effectiveQuantity ?? row.quantity ?? 0),
    0,
  );
  const metrics = [
    { label: "可提交", value: readyRows.length },
    { label: "需处理", value: attentionCount },
    { label: "重复跳过", value: rows.filter((row) => row.status === "DUPLICATE").length },
    { label: "包裹", value: uniquePackageCount(rows) },
    { label: "发货件数", value: quantity },
  ];

  return (
    <section
      aria-label="逐行校验工作台"
      className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background [&_[data-slot=table-container]]:rounded-none [&_[data-slot=table-container]]:border-0"
    >
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-ink">逐行校验</h2>
            <Badge
              className={
                attentionCount
                  ? "gap-1.5 border-warning/40 bg-warning/5 text-ink"
                  : "gap-1.5 border-success/35 bg-background text-success"
              }
              variant="outline"
            >
              {attentionCount ? (
                <AlertTriangle aria-hidden="true" className="size-3.5" />
              ) : (
                <CheckCircle2 aria-hidden="true" className="size-3.5" />
              )}
              {attentionCount ? `${attentionCount} 行待处理` : "全部校验通过"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted">
            正常行默认收起；失败行自动展开，可选择同系列 SKU、精确填写 SKU 或调整数量。
          </p>
        </div>
        <label className="flex min-h-10 w-fit cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            checked={onlyNeedsAttention}
            className="size-4 accent-primary"
            disabled={attentionCount === 0}
            onChange={(event) => setOnlyNeedsAttention(event.target.checked)}
            type="checkbox"
          />
          仅看需处理（{attentionCount}）
        </label>
      </div>

      <dl className="grid grid-cols-2 border-b border-border bg-surface/35 sm:grid-cols-5">
        {metrics.map((metric) => (
          <div className="border-r border-border px-4 py-2.5 even:border-r-0 sm:last:border-r-0 sm:even:border-r" key={metric.label}>
            <dt className="text-xs text-muted">{metric.label}</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">{metric.value}</dd>
          </div>
        ))}
      </dl>

      <Table className="block w-full md:table md:min-w-[980px]" aria-label="逐行校验结果">
        <TableHeader className="hidden md:table-header-group">
          <TableRow>
            <TableHead className="w-16">行</TableHead>
            <TableHead className="w-[17rem]">订单号 / 子订单号</TableHead>
            <TableHead>原 SKU → 最终 SKU</TableHead>
            <TableHead className="w-24">数量</TableHead>
            <TableHead className="w-24">库存</TableHead>
            <TableHead className="w-28">结果</TableHead>
            <TableHead className="w-24 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="block divide-y divide-border md:table-row-group md:divide-y-0">
          {visibleRows.map((row) => (
            <ImportRowEditor
              action={action}
              batchId={batchId}
              key={`${row.id}:${row.revision}`}
              row={row}
            />
          ))}
          {visibleRows.length === 0 ? (
            <TableRow className="block md:table-row">
              <TableCell className="block h-24 pt-9 text-center text-muted md:table-cell md:pt-2" colSpan={7}>
                当前没有需要处理的行。
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </section>
  );
}
