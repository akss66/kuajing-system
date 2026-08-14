"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminCatalogItem } from "@/modules/catalog/admin-catalog";
import {
  filterCatalogGroups,
  filterCatalogGroupVariants,
  groupCatalogItems,
  type CatalogSaleStatusFilter,
} from "@/modules/catalog/product-groups";
import type { ManagedAction } from "@/shared/action-state";

import { AliasDrawer, CreateSkuDrawer, CustomerPriceDrawer } from "./catalog-mutation-drawers";
import { CatalogResults } from "./catalog-results";
import { CatalogSaleStatusFilterControl } from "./catalog-sale-status-filter";

export { CustomerCatalogWorkspace } from "./customer-catalog-workspace";

export type CatalogRow = AdminCatalogItem;

export type CatalogWorkspaceProps = {
  actions: {
    createAlias: ManagedAction;
    createSku: ManagedAction;
    setCustomerPrice: ManagedAction;
  };
  customers: { code: string; id: string }[];
  rows: CatalogRow[];
  stores: { id: string; name: string }[];
};

function adminVariantSearchValues(variant: AdminCatalogItem) {
  return [
    variant.skuCode,
    variant.specification,
    variant.color,
    variant.combination,
    variant.color ? `颜色：${variant.color}` : null,
    variant.combination ? `组合销售：${variant.combination}` : null,
    variant.weightGrams !== null ? `重量：${variant.weightGrams} 克` : null,
    variant.linkText,
    variant.productUrl,
  ];
}

export function CatalogWorkspace({ actions, customers, rows, stores }: CatalogWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [saleStatus, setSaleStatus] = useState<CatalogSaleStatusFilter>("ALL");
  const groups = useMemo(() => groupCatalogItems(rows), [rows]);
  const searchedGroups = useMemo(
    () => filterCatalogGroups(groups, query, adminVariantSearchValues),
    [groups, query],
  );
  const filteredGroups = useMemo(
    () => filterCatalogGroupVariants(
      searchedGroups,
      saleStatus,
      (variant) => variant.saleStatus === "SELLABLE",
    ),
    [saleStatus, searchedGroups],
  );
  const filteredSkuCount = filteredGroups.reduce(
    (count, group) => count + group.variants.length,
    0,
  );

  return (
    <div className="min-w-0 space-y-6" data-admin-catalog-workspace>
      <PageHeading
        action={<CreateSkuDrawer action={actions.createSku} />}
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "商品与 SKU" }]}
        description="按来源序号、商品、真实规格或 SKU 快速核对货盘，并维护客户价格和店铺映射。"
        title="商品与 SKU"
      />
      <section aria-label="商品与 SKU 搜索及操作" className="flex min-w-0 flex-wrap items-center gap-3 border-y border-border py-4">
        <label className="relative min-w-0">
          <span className="sr-only">搜索商品与 SKU</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索商品与 SKU" className="min-h-11 pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU、商品或规格" type="search" value={query} />
        </label>
        <CatalogSaleStatusFilterControl onValueChange={setSaleStatus} value={saleStatus} />
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:ml-auto">
          <CustomerPriceDrawer action={actions.setCustomerPrice} customers={customers} rows={rows} />
          <AliasDrawer action={actions.createAlias} rows={rows} stores={stores} />
        </div>
      </section>
      <section aria-label="商品与 SKU 结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-foreground">SKU 货盘</h2><p className="text-sm tabular-nums text-muted-foreground">{filteredGroups.length} 个商品 / {filteredSkuCount} 个 SKU</p></div>
        {filteredGroups.length > 0 ? <CatalogResults groups={filteredGroups} /> : (
          <ActionableEmptyState
            action={saleStatus !== "ALL" ? <Button className="min-h-11" onClick={() => setSaleStatus("ALL")} type="button" variant="outline">显示全部 SKU</Button> : query ? <Button className="min-h-11" onClick={() => setQuery("")} type="button" variant="outline">清除搜索</Button> : undefined}
            description={saleStatus !== "ALL" ? "当前销售状态下没有结果，请切换销售状态。" : query ? "当前搜索条件下没有结果，请调整关键词。" : "创建首个标准 SKU 后，客户货盘和库存会在这里建立关联。"}
            kind={saleStatus !== "ALL" || query ? "filtered" : "initial"}
            title={saleStatus !== "ALL" || query ? "没有符合条件的 SKU" : "暂无 SKU"}
          />
        )}
      </section>
    </div>
  );
}
