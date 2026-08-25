"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
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

import { AliasDrawer, BatchSkuDrawer, CreateSkuDrawer } from "./catalog-mutation-drawers";
import { CatalogResults } from "./catalog-results";
import { CatalogSaleStatusFilterControl } from "./catalog-sale-status-filter";

export { CustomerCatalogWorkspace } from "./customer-catalog-workspace";

export type CatalogRow = AdminCatalogItem;
export type CatalogProductOption = {
  id: string;
  linkText: string | null;
  name: string;
  sourceSequence: string | null;
};

export type CatalogWorkspaceProps = {
  actions: {
    batchManage: ManagedAction;
    createAlias: ManagedAction;
    createSku: ManagedAction;
    deleteSku: ManagedAction;
    restoreSku: ManagedAction;
    updateProduct: ManagedAction;
    updateSku: ManagedAction;
  };
  lifecycle?: "ACTIVE" | "ARCHIVED";
  products?: CatalogProductOption[];
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

export function CatalogWorkspace({
  actions,
  lifecycle = "ACTIVE",
  products = [],
  rows,
  stores,
}: CatalogWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [saleStatus, setSaleStatus] = useState<CatalogSaleStatusFilter>("ALL");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const hasQuery = query.length > 0;
  const hasStatusFilter = saleStatus !== "ALL";
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
  const filteredSellableCount = filteredGroups.reduce(
    (count, group) =>
      count + group.variants.filter((variant) => variant.saleStatus === "SELLABLE").length,
    0,
  );
  const filteredUnavailableCount = filteredSkuCount - filteredSellableCount;
  const totalAvailableQuantity = filteredGroups.reduce(
    (count, group) =>
      count +
      group.variants.reduce(
        (groupCount, variant) => groupCount + variant.availableQuantity,
        0,
      ),
    0,
  );
  const resetFilters = () => {
    setQuery("");
    setSaleStatus("ALL");
  };

  return (
    <div className="min-w-0 space-y-6" data-admin-catalog-workspace>
      <PageHeading
        action={lifecycle === "ACTIVE" ? <CreateSkuDrawer action={actions.createSku} products={products} /> : undefined}
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "商品与 SKU" }]}
        description="按商品分组维护标准 SKU、价格、可售状态、库存与店铺映射。这个页面是系统货盘的主工作台，不再把信息堆成一张大表。"
        title="商品与 SKU"
      />
      <WorkspacePanel className="overflow-hidden border-border bg-background">
        <div className="grid gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center sm:px-5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary-hover">货盘维护路径</p>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">先定位商品，再判断可售、库存和映射，最后批量处理</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              客户看到的实时货盘、下单校验结果和库存占用都依赖这里的标准 SKU。货盘维护不再和历史恢复、批量映射混在同一层，先筛选当前范围，再执行动作。
            </p>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground xl:max-w-xl xl:justify-end">
            <span>标准 SKU 保持商品与规格一致</span>
            <span>可售状态直接影响客户下单</span>
            <span>批量动作只作用于勾选项</span>
          </div>
        </div>
      </WorkspacePanel>
      <MetricStrip
        items={[
          { hint: hasQuery || hasStatusFilter ? "按当前筛选计算" : "货盘中的可见商品组", label: "商品组", value: String(filteredGroups.length) },
          { hint: "支持批量管理、映射和单独维护", label: "SKU", value: String(filteredSkuCount) },
          { hint: "可售状态直接影响客户货盘", label: "可售 / 不可售", value: `${filteredSellableCount} / ${filteredUnavailableCount}` },
          { hint: "当前列表汇总，不含已归档 SKU", label: "可售库存", value: String(totalAvailableQuantity) },
        ]}
      />
      <WorkspacePanel>
        <section aria-label="商品与 SKU 搜索及操作" className="min-w-0">
          <div className="grid gap-3 p-4 lg:grid-cols-[minmax(18rem,1fr)_auto] lg:items-center sm:p-5">
            <label className="relative min-w-0">
              <span className="sr-only">搜索商品与 SKU</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="搜索商品与 SKU" className="min-h-11 w-full pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU、商品名称、规格或颜色" type="search" value={query} />
            </label>
            <CatalogSaleStatusFilterControl onValueChange={setSaleStatus} value={saleStatus} />
          </div>
          <div className="flex min-w-0 flex-col gap-3 border-t border-border bg-surface/45 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {selectedIds.size ? `已选择 ${selectedIds.size} 个 SKU，可直接进行批量操作。` : "先筛选，再选择 SKU 做批量处理。"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {!selectedIds.size
                  ? "支持批量调整销售状态、归属商品和店铺映射；归档 SKU 可在历史视图里恢复。"
                  : "批量操作只作用于当前勾选项，不会误伤未勾选的 SKU。"}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button asChild className="min-h-10" size="sm" variant="outline"><Link href={lifecycle === "ACTIVE" ? "/admin/catalog?lifecycle=archived" : "/admin/catalog"}>{lifecycle === "ACTIVE" ? "已删除 SKU" : "返回在用 SKU"}</Link></Button>
              {lifecycle === "ACTIVE" ? <BatchSkuDrawer action={actions.batchManage} products={products} selectedIds={[...selectedIds]} /> : null}
              {lifecycle === "ACTIVE" ? <AliasDrawer action={actions.createAlias} rows={rows} stores={stores} /> : null}
            </div>
          </div>
        </section>
      </WorkspacePanel>
      <section aria-label="商品与 SKU 结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-foreground">商品列表</h2><p className="text-sm tabular-nums text-muted-foreground">{filteredGroups.length} 个商品 / {filteredSkuCount} 个 SKU</p></div>
        {filteredGroups.length > 0 ? <CatalogResults
          actions={actions}
          groups={filteredGroups}
          onSelectionChange={setSelectedIds}
          selectedIds={selectedIds}
        /> : (
          <ActionableEmptyState
            action={
              hasQuery && hasStatusFilter ? (
                <Button className="min-h-11" onClick={resetFilters} type="button" variant="outline">
                  清除筛选
                </Button>
              ) : hasStatusFilter ? (
                <Button className="min-h-11" onClick={() => setSaleStatus("ALL")} type="button" variant="outline">
                  显示全部 SKU
                </Button>
              ) : hasQuery ? (
                <Button className="min-h-11" onClick={() => setQuery("")} type="button" variant="outline">
                  清除搜索
                </Button>
              ) : undefined
            }
            description={hasStatusFilter ? "当前销售状态下没有结果，请切换销售状态。" : hasQuery ? "当前搜索条件下没有结果，请调整关键词。" : "创建首个标准 SKU 后，客户货盘和库存会在这里建立关联。"}
            kind={hasStatusFilter || hasQuery ? "filtered" : "initial"}
            title={hasStatusFilter || hasQuery ? "没有符合条件的 SKU" : "暂无 SKU"}
          />
        )}
      </section>
    </div>
  );
}
