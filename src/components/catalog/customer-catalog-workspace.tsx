"use client";

import { ExternalLink, ImageIcon, Search, Upload } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CustomerCatalogItem } from "@/modules/catalog/customer-catalog";
import {
  filterCatalogGroups,
  filterCatalogGroupVariants,
  groupCatalogItems,
  sortCatalogGroups,
  type CatalogSaleStatusFilter,
  type CatalogProductGroup,
  type CatalogSortOrder,
} from "@/modules/catalog/product-groups";
import { formatMilliYuan } from "@/modules/catalog/unit-price";

import { CatalogSaleStatusFilterControl } from "./catalog-sale-status-filter";
import { CatalogImagePreview } from "./catalog-image-preview";

type CustomerCatalogGroupableItem = CustomerCatalogItem & { sourceSequence: null };

function customerVariantSearchValues(item: CustomerCatalogItem) {
  return [
    item.skuCode,
    item.specification,
    item.color,
    item.combination,
    item.weightGrams === null ? null : String(item.weightGrams),
    item.weightGrams === null ? null : `重量：${item.weightGrams} 克`,
    item.linkText,
    item.productUrl,
  ];
}

function toCustomerCatalogGroupableItem(
  item: CustomerCatalogItem,
): CustomerCatalogGroupableItem {
  return { ...item, sourceSequence: null };
}

function CatalogImage({ item }: { item: CustomerCatalogItem }) {
  if (item.imageUrl) {
    return <CatalogImagePreview imageUrl={item.imageUrl} productName={item.productName} />;
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

function VariantIdentity({ item }: { item: CustomerCatalogItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <CatalogImage item={item} />
      <div className="min-w-0">
        <p
          className="line-clamp-1 whitespace-normal break-words text-sm font-semibold tabular-nums text-foreground lg:line-clamp-2"
          title={item.skuCode}
        >
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
        className="line-clamp-1 whitespace-normal break-words text-sm leading-5 text-foreground lg:line-clamp-2 lg:text-base"
        title={item.specification ?? undefined}
      >
        {item.specification ?? "规格未提供"}
      </p>
      {attributes.length > 0 ? (
        <ul
          aria-label={`${item.skuCode} 属性`}
          className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 overflow-hidden lg:block lg:space-y-0.5"
        >
          {attributes.map((attribute) => (
            <li
              className="max-w-full truncate text-xs leading-4 text-muted-foreground lg:whitespace-normal lg:break-words"
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
  if (reason === "PRICE_MISSING") return "价格待维护";
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

function CustomerUnitPrice({ value }: { value: number | null }) {
  return value === null ? (
    <span className="text-muted-foreground">价格待维护</span>
  ) : (
    <>{formatMilliYuan(value)}</>
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

function CatalogProductLink({
  item,
  visibleLabel,
}: {
  item: CustomerCatalogItem;
  visibleLabel?: string;
}) {
  if (!item.productUrl) {
    return <span className="text-sm text-muted-foreground">暂无链接</span>;
  }

  const safeUrl = safeAbsoluteHttpUrl(item.productUrl);
  if (!safeUrl) {
    return <span className="text-sm text-muted-foreground">链接不可用</span>;
  }

  return (
    <a
      aria-label={visibleLabel ? item.linkText?.trim() || "查看商品详情" : undefined}
      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 whitespace-normal break-words text-sm font-medium text-primary underline-offset-4 hover:underline"
      href={safeUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="line-clamp-2">{visibleLabel ?? (item.linkText?.trim() || "查看商品详情")}</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );
}

function ProductGroupHeader({
  group,
}: {
  group: CatalogProductGroup<CustomerCatalogGroupableItem>;
}) {
  return (
    <header className="min-w-0 bg-white px-3 py-2.5 sm:px-5 sm:py-3">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <h3 className="line-clamp-1 whitespace-normal break-words text-sm font-semibold text-foreground sm:line-clamp-2 sm:text-base">
            {group.productName}
          </h3>
          <p className="mt-0.5 line-clamp-1 whitespace-normal break-words text-xs text-muted-foreground">
            {group.linkText?.trim() || "暂无商品链接"}
          </p>
        </div>
        <Badge className="shrink-0 bg-white/80 text-primary-hover ring-1 ring-primary/10" variant="secondary">
          {group.variants.length} 个 SKU
        </Badge>
      </div>
    </header>
  );
}

function CustomerCatalogList({
  groups,
}: {
  groups: CatalogProductGroup<CustomerCatalogGroupableItem>[];
}) {
  const productNameCounts = new Map<string, number>();
  for (const group of groups) {
    productNameCounts.set(
      group.productName,
      (productNameCounts.get(group.productName) ?? 0) + 1,
    );
  }

  return (
    <ul
      aria-label="客户货盘长条列表"
      className="space-y-2 sm:space-y-3"
      data-customer-catalog-list
    >
      {groups.map((group) => (
        <li
          className="min-w-0 overflow-hidden rounded-xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)] sm:rounded-2xl"
          data-testid={`catalog-product-${group.productId}`}
          key={group.productId}
        >
          <ProductGroupHeader group={group} />
          <ul
            aria-label={
              productNameCounts.get(group.productName) === 1
                ? `${group.productName} SKU 变体`
                : `${group.productName}（${group.variants[0]!.skuCode} 至 ${group.variants.at(-1)!.skuCode}）SKU 变体`
            }
            className="divide-y divide-slate-100 border-t border-slate-100"
          >
            {group.variants.map((item) => (
              <li
                className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors hover:bg-slate-50/70 sm:px-5 lg:grid-cols-[minmax(13rem,1.15fr)_minmax(16rem,1.35fr)_minmax(6.5rem,0.5fr)_minmax(6rem,0.45fr)_minmax(5.5rem,0.4fr)] lg:items-center lg:gap-3 lg:py-3"
                data-customer-catalog-row
                data-testid={`catalog-${item.id}`}
                key={item.id}
              >
                <div className="col-span-2 min-w-0 lg:col-span-1" data-customer-catalog-section="identity">
                  <VariantIdentity item={item} />
                </div>
                <div
                  className="col-span-2 -mt-7 min-w-0 pl-[3.75rem] lg:col-span-1 lg:mt-0 lg:pl-0"
                  data-customer-catalog-section="attributes"
                >
                  <CatalogAttributes item={item} />
                </div>
                <div
                  className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:col-span-3 lg:col-start-auto lg:grid lg:grid-cols-[minmax(6.5rem,0.5fr)_minmax(6rem,0.45fr)_minmax(5.5rem,0.4fr)] lg:items-center lg:gap-3"
                  data-customer-catalog-commerce
                >
                  <dl className="flex items-baseline gap-1 lg:block" data-customer-catalog-section="price">
                    <dt className="sr-only lg:not-sr-only lg:text-xs lg:font-medium lg:text-muted-foreground">拿货价</dt>
                    <dd className="text-base font-semibold tabular-nums text-foreground lg:mt-0.5">
                      <CustomerUnitPrice value={item.actualUnitPriceMilliYuan} />
                    </dd>
                  </dl>
                  <dl
                    aria-label="可售库存"
                    className="flex items-baseline gap-1 lg:block"
                    data-customer-catalog-section="inventory"
                  >
                    <dt aria-hidden="true" className="text-xs font-normal text-muted-foreground lg:font-medium">
                      <span className="lg:hidden">库存</span>
                      <span className="hidden lg:inline">可售库存</span>
                    </dt>
                    <dd className="font-semibold tabular-nums text-foreground lg:mt-0.5">
                      {item.availableQuantity}
                    </dd>
                  </dl>
                  <div className="flex items-center gap-2 lg:justify-end">
                    <span data-customer-catalog-section="status">
                      <CatalogStatus item={item} />
                    </span>
                    <span data-customer-catalog-section="link">
                      <CatalogProductLink item={item} visibleLabel="查看" />
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function CustomerCatalogResults({
  groups,
}: {
  groups: CatalogProductGroup<CustomerCatalogGroupableItem>[];
}) {
  return (
    <div data-testid="customer-catalog-results">
      <CustomerCatalogList groups={groups} />
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
  const [saleStatus, setSaleStatus] = useState<CatalogSaleStatusFilter>("ALL");
  const [sortOrder, setSortOrder] = useState<CatalogSortOrder>("SKU_ASC");
  const [draftQuery, setDraftQuery] = useState(query);
  const [searchQuery, setSearchQuery] = useState(query);
  const groupedItems = useMemo(
    () => groupCatalogItems(items.map(toCustomerCatalogGroupableItem)),
    [items],
  );
  const searchedGroups = useMemo(
    () => filterCatalogGroups(groupedItems, searchQuery, customerVariantSearchValues),
    [groupedItems, searchQuery],
  );
  const filteredGroups = useMemo(
    () =>
      filterCatalogGroupVariants(
        searchedGroups,
        saleStatus,
        (variant) => variant.availabilityReason === "AVAILABLE",
      ),
    [saleStatus, searchedGroups],
  );
  const sortedGroups = useMemo(
    () =>
      sortCatalogGroups(
        filteredGroups,
        sortOrder,
        (variant) =>
          variant.actualUnitPriceMilliYuan ??
          (sortOrder === "PRICE_DESC" ? -1 : Number.MAX_SAFE_INTEGER),
      ),
    [filteredGroups, sortOrder],
  );
  const skuCount = sortedGroups.reduce((count, group) => count + group.variants.length, 0);
  const resetFilters = () => {
    setSaleStatus("ALL");
    setSearchQuery("");
    setDraftQuery("");
  };

  return (
    <div className="min-w-0 space-y-5" data-customer-catalog-workspace>
      <PageHeading
        action={
          <Button asChild className="min-h-12 px-5">
            <Link href="/portal/imports/new"><Upload aria-hidden="true" />上传订单</Link>
          </Button>
        }
        description="查看你的拿货价和扣除有效锁定后的可售库存；最终库存会在提交订单时再次校验。"
        title="实时货盘"
      />
      <section aria-label="货盘搜索" className="rounded-[var(--portal-surface-radius)] border border-border bg-background p-3 sm:p-4" data-portal-toolbar>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">查找实时货盘</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">支持 SKU、商品、规格、颜色和商品链接文字。</p>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{groupedItems.length} 个商品可搜索</span>
        </div>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <form
            className="grid min-w-0 gap-3 sm:flex-1 sm:grid-cols-[minmax(0,36rem)_auto] sm:justify-start"
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchQuery(draftQuery);
            }}
          >
            <label className="relative min-w-0">
              <span className="sr-only">搜索 SKU、商品、规格或链接文字</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="搜索 SKU、商品、规格或链接文字"
                className="min-h-12 pl-10"
                name="q"
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="搜索 SKU、商品、规格或链接文字"
                type="search"
                value={draftQuery}
              />
            </label>
            <Button className="min-h-11 px-5" data-portal-action="search-catalog" size="lg" type="submit">
              <Search aria-hidden="true" />
              搜索货盘
            </Button>
          </form>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <Select
              onValueChange={(value) => setSortOrder(value as CatalogSortOrder)}
              value={sortOrder}
            >
              <SelectTrigger
                aria-label="货盘排序方式"
                className="min-h-12 w-full sm:w-48"
                data-portal-control="catalog-sort"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="SKU_ASC">SKU 顺序</SelectItem>
                <SelectItem value="PRICE_ASC">货价：从低到高</SelectItem>
                <SelectItem value="PRICE_DESC">货价：从高到低</SelectItem>
              </SelectContent>
            </Select>
            <CatalogSaleStatusFilterControl onValueChange={setSaleStatus} value={saleStatus} />
          </div>
        </div>
      </section>
      <section aria-label="客户货盘结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">可选货盘</h2>
          <p aria-live="polite" className="text-sm tabular-nums text-muted-foreground" role="status">
            {sortedGroups.length} 个商品 / {skuCount} 个 SKU
          </p>
        </div>
        {sortedGroups.length > 0 ? (
          <CustomerCatalogResults groups={sortedGroups} />
        ) : (
          <ActionableEmptyState
            action={
              saleStatus !== "ALL" || searchQuery ? (
                <Button className="min-h-11" onClick={resetFilters} type="button" variant="outline">
                  清除筛选
                </Button>
              ) : undefined
            }
            description={
              saleStatus !== "ALL"
                ? "当前销售状态下没有结果，请切换销售状态。"
                : searchQuery
                  ? "当前关键词没有匹配的 SKU，请清除或调整搜索。"
                  : "当前没有可选 SKU，请联系管理员确认货盘状态。"
            }
            kind={saleStatus !== "ALL" || searchQuery ? "filtered" : "initial"}
            title={saleStatus !== "ALL" || searchQuery ? "没有符合条件的 SKU" : "暂无可选货盘"}
          />
        )}
      </section>
    </div>
  );
}
