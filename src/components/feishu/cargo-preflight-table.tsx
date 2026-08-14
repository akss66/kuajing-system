"use client";

import Link from "next/link";
import { useState } from "react";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CargoMigrationPanelRow } from "@/modules/feishu/queries";

function toneClass(issueCount: number) {
  return issueCount > 0
    ? "bg-warning/10 text-warning"
    : "bg-success/10 text-success";
}

function CompactList({
  emptyLabel,
  items,
}: {
  emptyLabel: string;
  items: string[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <p className="text-sm leading-5 text-foreground" key={item}>
          {item}
        </p>
      ))}
    </div>
  );
}

export function CargoPreflightTable({
  rows,
}: {
  rows: CargoMigrationPanelRow[];
}) {
  const firstActionableKey = rows.find((row) => row.issueLabels.length > 0)
    ? `${rows.find((row) => row.issueLabels.length > 0)!.sourceRowNumber}-${rows.find((row) => row.issueLabels.length > 0)!.skuCode}`
    : null;
  const [expandedRowKeys, setExpandedRowKeys] = useState<Set<string>>(
    () => new Set(firstActionableKey ? [firstActionableKey] : []),
  );

  return (
    <div className="space-y-4">
      <div className="space-y-3 md:hidden">
        {rows.map((row) => {
          const rowKey = `${row.sourceRowNumber}-${row.skuCode}`;
          const expanded = expandedRowKeys.has(rowKey);
          const issueSummary =
            row.issueLabels.length > 0 ? `${row.issueLabels.length} 个问题` : "无阻断问题";
          const detailsId = `cargo-row-details-${rowKey}`;

          return (
            <article
              className="rounded-[var(--radius-surface)] border border-border bg-background"
              key={rowKey}
            >
              <div className="flex items-start justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {row.productName}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    第 {row.sourceRowNumber} 行 · {row.skuCode}
                  </p>
                </div>
                <Badge className={toneClass(row.issueLabels.length)} variant="secondary">
                  {row.issueLabels.length > 0 ? "需处理" : row.imageStateLabel}
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-3 border-t border-border px-4 py-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">问题</p>
                  <p className="mt-1 text-foreground">{issueSummary}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">库存</p>
                  <p className="mt-1 text-foreground">{row.totalQuantity}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">图片</p>
                  <p className="mt-1 text-foreground">{row.imageStateLabel}</p>
                </div>
              </div>

              <button
                aria-controls={detailsId}
                aria-expanded={expanded}
                className="flex min-h-11 w-full items-center justify-between border-t border-border px-4 py-3 text-left text-sm font-medium text-foreground"
                onClick={() =>
                  setExpandedRowKeys((current) => {
                    const next = new Set(current);
                    if (next.has(rowKey)) {
                      next.delete(rowKey);
                    } else {
                      next.add(rowKey);
                    }
                    return next;
                  })
                }
                type="button"
              >
                <span>查看详情</span>
                <span className="text-xs text-muted-foreground">
                  {expanded ? "收起" : "展开"}
                </span>
              </button>

              <div
                className={cn(
                  "space-y-3 border-t border-border px-4 py-4",
                  expanded ? "block" : "hidden",
                )}
                id={detailsId}
              >
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">商品分组</p>
                    <p className="mt-1 break-all text-foreground">{row.productGroupKey}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">价格</p>
                    <p className="mt-1 text-foreground">{row.defaultUnitPriceLabel}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">规格</p>
                    <p className="mt-1 text-foreground">{row.specification}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">重量</p>
                    <p className="mt-1 text-foreground">{row.weightLabel}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">状态</p>
                    <p className="mt-1 text-foreground">{row.saleStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">图片摘要</p>
                    <p className="mt-1 text-foreground">{row.imageDigestLabel}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">链接</p>
                  {row.productUrl ? (
                    <Link
                      className="mt-1 block break-all text-sm text-primary underline-offset-4 hover:underline"
                      href={row.productUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {row.productUrl}
                    </Link>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">无商品链接</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">继承字段</p>
                  <div className="mt-1">
                    <CompactList emptyLabel="无继承字段" items={row.inheritedFieldLabels} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">问题</p>
                  <div className="mt-1">
                    <CompactList emptyLabel="无阻断问题" items={row.issueLabels} />
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="hidden md:block">
        <ResponsiveDataTable>
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <th className="border-b border-border px-3 py-3 font-medium">源行</th>
                <th className="border-b border-border px-3 py-3 font-medium">商品 / SKU</th>
                <th className="border-b border-border px-3 py-3 font-medium">图片</th>
                <th className="border-b border-border px-3 py-3 font-medium">价格 / 库存</th>
                <th className="border-b border-border px-3 py-3 font-medium">规格 / 重量</th>
                <th className="border-b border-border px-3 py-3 font-medium">链接 / 状态</th>
                <th className="border-b border-border px-3 py-3 font-medium">继承字段</th>
                <th className="border-b border-border px-3 py-3 font-medium">问题</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="align-top" key={`${row.sourceRowNumber}-${row.skuCode}`}>
                  <td className="border-b border-border px-3 py-3 text-foreground">
                    {row.sourceRowNumber}
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <p className="font-medium text-foreground">{row.productName}</p>
                    <p className="mt-1 text-muted-foreground">{row.productGroupKey}</p>
                    <p className="mt-1 text-foreground">{row.skuCode}</p>
                    <p className="mt-1 text-muted-foreground">{row.skuName}</p>
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <p className="text-foreground">{row.imageStateLabel}</p>
                    <p className="mt-1 text-muted-foreground">{row.imageDigestLabel}</p>
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <p className="text-foreground">{row.defaultUnitPriceLabel}</p>
                    <p className="mt-1 text-muted-foreground">{row.totalQuantity}</p>
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <p className="text-foreground">{row.specification}</p>
                    <p className="mt-1 text-muted-foreground">{row.weightLabel}</p>
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    {row.productUrl ? (
                      <Link
                        className="break-all text-primary underline-offset-4 hover:underline"
                        href={row.productUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {row.productUrl}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">无商品链接</span>
                    )}
                    <p className="mt-1 text-muted-foreground">{row.saleStatusLabel}</p>
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <CompactList emptyLabel="无继承字段" items={row.inheritedFieldLabels} />
                  </td>
                  <td className="border-b border-border px-3 py-3">
                    <CompactList emptyLabel="无阻断问题" items={row.issueLabels} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveDataTable>
      </div>
    </div>
  );
}
