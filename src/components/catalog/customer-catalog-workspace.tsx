"use client";

import { ImageIcon, Search } from "lucide-react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CustomerCatalogItem } from "@/modules/catalog/customer-catalog";

function CustomerCatalogResults({ items }: { items: CustomerCatalogItem[] }) {
  return (
    <div data-testid="customer-catalog-results">
      <div className="hidden md:block" data-customer-catalog-table>
        <Table aria-label="客户货盘列表" className="table-fixed min-w-[720px]">
          <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>商品</TableHead><TableHead>规格</TableHead><TableHead className="text-right">实际拿货价</TableHead><TableHead className="text-right">可售库存</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow data-testid={`catalog-${item.id}`} key={item.id}>
                <TableCell className="font-semibold tabular-nums">{item.skuCode}</TableCell>
                <TableCell>{item.productName}</TableCell>
                <TableCell>{item.skuName}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">¥{(item.actualUnitPriceFen / 100).toFixed(2)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{item.availableQuantity}</TableCell>
                <TableCell><Badge className={item.sellable ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"} variant="secondary">{item.sellable ? `可售 ${item.availableQuantity}` : "不可售"}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label="客户货盘列表" className="space-y-3 md:hidden" data-customer-catalog-cards>
        {items.map((item) => (
          <li className="rounded-[var(--radius-surface)] border border-border bg-background p-4" data-testid={`catalog-${item.id}`} key={item.id}>
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface text-muted-foreground"><ImageIcon aria-hidden="true" className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <p className="truncate font-semibold tabular-nums text-foreground">{item.skuCode}</p>
                  <Badge className={item.sellable ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"} variant="secondary">{item.sellable ? "可售" : "不可售"}</Badge>
                </div>
                <p className="mt-1 text-sm font-medium text-foreground">{item.productName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.skuName}</p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-3">
              <div><dt className="text-xs font-medium text-muted-foreground">实际拿货价</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">¥{(item.actualUnitPriceFen / 100).toFixed(2)}</dd></div>
              <div className="text-right"><dt className="text-xs font-medium text-muted-foreground">可售库存</dt><dd className={item.sellable ? "mt-1 text-sm font-semibold tabular-nums text-success" : "mt-1 text-sm font-semibold text-destructive"}>{item.sellable ? `可售 ${item.availableQuantity}` : "不可售"}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CustomerCatalogWorkspace({ items, query }: { items: CustomerCatalogItem[]; query: string }) {
  return (
    <div className="min-w-0 space-y-5" data-customer-catalog-workspace>
      <PageHeading description="这里仅显示你的实际拿货价，以及扣除有效锁定后的实时可售库存。" title="货盘选品" />
      <section aria-label="货盘搜索" className="border-y border-border py-4">
        <form className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,36rem)_auto] sm:justify-start" method="get">
          <label className="relative min-w-0">
            <span className="sr-only">搜索 SKU 或商品名称</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="搜索 SKU 或商品名称" className="min-h-11 pl-10" defaultValue={query} name="q" placeholder="搜索 SKU 或商品名称" type="search" />
          </label>
          <Button className="min-h-11 bg-primary-hover" type="submit">搜索货盘</Button>
        </form>
      </section>
      <section aria-label="客户货盘结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-foreground">可选货盘</h2><p className="text-sm tabular-nums text-muted-foreground">{items.length} 个结果</p></div>
        {items.length > 0 ? <CustomerCatalogResults items={items} /> : (
          <ActionableEmptyState
            action={query ? <Button asChild className="min-h-11" variant="outline"><a href="/portal/catalog">清除搜索</a></Button> : undefined}
            description={query ? "当前关键词没有匹配的 SKU，请清除或调整搜索。" : "当前没有可选 SKU，请联系管理员确认货盘状态。"}
            kind={query ? "filtered" : "initial"}
            title={query ? "没有符合条件的 SKU" : "暂无可选货盘"}
          />
        )}
      </section>
    </div>
  );
}
