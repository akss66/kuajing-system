"use client";

import Link from "next/link";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { Badge } from "@/components/ui/badge";

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
  return (
    <div className="space-y-4">
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <article
            className="rounded-[var(--radius-surface)] border border-border bg-background px-4 py-4"
            key={`${row.sourceRowNumber}-${row.skuCode}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
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
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">商品分组</p>
                <p className="mt-1 break-all text-foreground">{row.productGroupKey}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">价格</p>
                <p className="mt-1 text-foreground">{row.defaultUnitPriceLabel}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">库存</p>
                <p className="mt-1 text-foreground">{row.totalQuantity}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">重量</p>
                <p className="mt-1 text-foreground">{row.weightLabel}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">规格</p>
                <p className="mt-1 text-foreground">{row.specification}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">状态</p>
                <p className="mt-1 text-foreground">{row.saleStatusLabel}</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-xs text-muted-foreground">链接</p>
                <Link
                  className="mt-1 block break-all text-sm text-primary underline-offset-4 hover:underline"
                  href={row.productUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {row.productUrl}
                </Link>
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
        ))}
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
                    <Link
                      className="break-all text-primary underline-offset-4 hover:underline"
                      href={row.productUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {row.productUrl}
                    </Link>
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
