"use client";

import { ExternalLink, ImageIcon, Search } from "lucide-react";
import Image from "next/image";

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
import { formatMilliYuan } from "@/modules/catalog/unit-price";

function CatalogImage({ item }: { item: CustomerCatalogItem }) {
  if (item.imageUrl) {
    return (
      <Image
        alt={`${item.productName} 商品图片`}
        className="size-12 shrink-0 rounded-[var(--radius-control)] border border-border object-cover"
        height={48}
        sizes="48px"
        src={item.imageUrl}
        unoptimized
        width={48}
      />
    );
  }

  return (
    <span
      aria-label={`${item.productName} 图片缺失`}
      className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface text-muted-foreground"
      role="img"
    >
      <ImageIcon aria-hidden="true" className="size-4" />
    </span>
  );
}

function ProductIdentity({ item }: { item: CustomerCatalogItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <CatalogImage item={item} />
      <div className="min-w-0">
        <p className="line-clamp-2 whitespace-normal break-words font-medium text-foreground">
          {item.productName}
        </p>
        <p className="mt-1 truncate text-xs font-semibold tabular-nums text-muted-foreground">
          {item.skuCode}
        </p>
      </div>
    </div>
  );
}

function CatalogAttributes({ item }: { item: CustomerCatalogItem }) {
  const attributes = [
    item.color ? `颜色：${item.color}` : null,
    item.combination ? `组合销售：${item.combination}` : null,
    item.weightGrams !== null ? `重量：${item.weightGrams} 克` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="min-w-0">
      <p
        className="line-clamp-2 whitespace-normal break-words leading-5 text-foreground"
        title={item.specification ?? undefined}
      >
        {item.specification ?? "规格未提供"}
      </p>
      {attributes.length > 0 ? (
        <ul aria-label={`${item.skuCode} 属性`} className="mt-1 space-y-0.5">
          {attributes.map((attribute) => (
            <li
              className="whitespace-normal break-words text-xs leading-4 text-muted-foreground"
              key={attribute}
            >
              {attribute}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function availabilityLabel(reason: CustomerCatalogItem["availabilityReason"]) {
  if (reason === "AVAILABLE") return "可售";
  if (reason === "MANUALLY_UNAVAILABLE") return "不可售";
  return "售罄";
}

function availabilityClassName(reason: CustomerCatalogItem["availabilityReason"]) {
  if (reason === "AVAILABLE") return "bg-success/10 text-success";
  if (reason === "SOLD_OUT") return "bg-warning/10 text-warning";
  return "bg-secondary text-secondary-foreground";
}

function CatalogStatus({ item }: { item: CustomerCatalogItem }) {
  return (
    <Badge className={availabilityClassName(item.availabilityReason)} variant="secondary">
      {availabilityLabel(item.availabilityReason)}
    </Badge>
  );
}

function safeAbsoluteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function CatalogProductLink({ item }: { item: CustomerCatalogItem }) {
  if (!item.productUrl) {
    return <span className="text-sm text-muted-foreground">暂无链接</span>;
  }

  const safeUrl = safeAbsoluteHttpUrl(item.productUrl);
  if (!safeUrl) {
    return <span className="text-sm text-muted-foreground">链接不可用</span>;
  }

  return (
    <a
      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 whitespace-normal break-words text-sm font-medium text-primary underline-offset-4 hover:underline xl:min-h-0"
      href={safeUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="line-clamp-2">{item.linkText?.trim() || "查看商品详情"}</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );
}

function CustomerCatalogTable({ items }: { items: CustomerCatalogItem[] }) {
  return (
    <div className="hidden min-w-0 xl:block" data-customer-catalog-table>
      <Table aria-label="客户货盘列表" className="w-full table-fixed">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[29%]" />
          <col className="w-[13%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[13%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>商品</TableHead>
            <TableHead>规格/属性</TableHead>
            <TableHead className="text-right">实际拿货价</TableHead>
            <TableHead className="text-right">可售库存</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>链接</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow
              data-testid={`catalog-${item.id}`}
              key={item.id}
            >
              <TableCell className="min-w-0 whitespace-normal align-top">
                <ProductIdentity item={item} />
              </TableCell>
              <TableCell className="min-w-0 whitespace-normal align-top">
                <CatalogAttributes item={item} />
              </TableCell>
              <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                {formatMilliYuan(item.actualUnitPriceMilliYuan)}
              </TableCell>
              <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                {item.availableQuantity}
              </TableCell>
              <TableCell className="whitespace-normal align-top">
                <CatalogStatus item={item} />
              </TableCell>
              <TableCell className="min-w-0 whitespace-normal align-top">
                <CatalogProductLink item={item} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CustomerCatalogCards({ items }: { items: CustomerCatalogItem[] }) {
  return (
    <ul
      aria-label="客户货盘卡片列表"
      className="space-y-3 xl:hidden"
      data-customer-catalog-cards
    >
      {items.map((item) => (
        <li
          className="min-w-0 rounded-[var(--radius-surface)] border border-border bg-background p-4"
          data-testid={`catalog-${item.id}`}
          key={item.id}
        >
          <div data-customer-catalog-section="identity">
            <ProductIdentity item={item} />
          </div>
          <div
            className="mt-4 border-t border-border pt-3"
            data-customer-catalog-section="attributes"
          >
            <p className="mb-1 text-xs font-medium text-muted-foreground">规格/属性</p>
            <CatalogAttributes item={item} />
          </div>
          <dl
            className="mt-4 border-t border-border pt-3"
            data-customer-catalog-section="price"
          >
            <dt className="text-xs font-medium text-muted-foreground">实际拿货价</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {formatMilliYuan(item.actualUnitPriceMilliYuan)}
            </dd>
          </dl>
          <dl
            className="mt-4 border-t border-border pt-3"
            data-customer-catalog-section="inventory"
          >
            <dt className="text-xs font-medium text-muted-foreground">可售库存</dt>
            <dd className="mt-1 font-semibold tabular-nums text-foreground">
              {item.availableQuantity}
            </dd>
          </dl>
          <div
            className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3"
            data-customer-catalog-section="status"
          >
            <span className="text-xs font-medium text-muted-foreground">状态</span>
            <CatalogStatus item={item} />
          </div>
          <div
            className="mt-3 flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3"
            data-customer-catalog-section="link"
          >
            <span className="text-xs font-medium text-muted-foreground">链接</span>
            <CatalogProductLink item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CustomerCatalogResults({ items }: { items: CustomerCatalogItem[] }) {
  return (
    <div data-testid="customer-catalog-results">
      <CustomerCatalogTable items={items} />
      <CustomerCatalogCards items={items} />
    </div>
  );
}

export function CustomerCatalogWorkspace({
  items,
  query,
}: {
  items: CustomerCatalogItem[];
  query: string;
}) {
  return (
    <div className="min-w-0 space-y-5" data-customer-catalog-workspace>
      <PageHeading
        description="这里仅显示你的实际拿货价，以及扣除有效锁定后的实时可售库存。"
        title="货盘选品"
      />
      <section aria-label="货盘搜索" className="border-y border-border py-4">
        <form
          className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,36rem)_auto] sm:justify-start"
          method="get"
        >
          <label className="relative min-w-0">
            <span className="sr-only">搜索 SKU、商品、规格或链接文字</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="搜索 SKU、商品、规格或链接文字"
              className="min-h-11 pl-10"
              defaultValue={query}
              name="q"
              placeholder="搜索 SKU、商品、规格或链接文字"
              type="search"
            />
          </label>
          <Button className="min-h-11" type="submit">
            搜索货盘
          </Button>
        </form>
      </section>
      <section aria-label="客户货盘结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">可选货盘</h2>
          <p className="text-sm tabular-nums text-muted-foreground">{items.length} 个结果</p>
        </div>
        {items.length > 0 ? (
          <CustomerCatalogResults items={items} />
        ) : (
          <ActionableEmptyState
            action={
              query ? (
                <Button asChild className="min-h-11" variant="outline">
                  <a href="/portal/catalog">清除搜索</a>
                </Button>
              ) : undefined
            }
            description={
              query
                ? "当前关键词没有匹配的 SKU，请清除或调整搜索。"
                : "当前没有可选 SKU，请联系管理员确认货盘状态。"
            }
            kind={query ? "filtered" : "initial"}
            title={query ? "没有符合条件的 SKU" : "暂无可选货盘"}
          />
        )}
      </section>
    </div>
  );
}
