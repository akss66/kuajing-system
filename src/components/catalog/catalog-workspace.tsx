"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManagedAction } from "@/shared/action-state";

import { AliasDrawer, CreateSkuDrawer, CustomerPriceDrawer } from "./catalog-mutation-drawers";
import { CatalogResults } from "./catalog-results";

export { CustomerCatalogWorkspace } from "./customer-catalog-workspace";

export type CatalogRow = {
  id: string;
  name: string;
  price: number;
  priceMilliYuan: number;
  productName: string;
  saleStatus: string;
  skuCode: string;
};

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

export function CatalogWorkspace({ actions, customers, rows, stores }: CatalogWorkspaceProps) {
  const [query, setQuery] = useState("");
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return rows;
    return rows.filter((row) =>
      [row.skuCode, row.productName, row.name]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized)),
    );
  }, [query, rows]);

  return (
    <div className="min-w-0 space-y-6" data-admin-catalog-workspace>
      <PageHeading
        action={<CreateSkuDrawer action={actions.createSku} />}
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "商品与 SKU" }]}
        description="搜索标准 SKU，按需维护统一拿货价、客户专属价和店铺 SKU 映射。"
        title="商品与 SKU"
      />
      <section aria-label="商品与 SKU 搜索及操作" className="grid min-w-0 gap-3 border-y border-border py-4 lg:grid-cols-[minmax(18rem,1fr)_auto_auto]">
        <label className="relative min-w-0">
          <span className="sr-only">搜索商品与 SKU</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索商品与 SKU" className="min-h-11 pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU、商品或规格" type="search" value={query} />
        </label>
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:contents">
          <CustomerPriceDrawer action={actions.setCustomerPrice} customers={customers} rows={rows} />
          <AliasDrawer action={actions.createAlias} rows={rows} stores={stores} />
        </div>
      </section>
      <section aria-label="商品与 SKU 结果" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-foreground">SKU 货盘</h2><p className="text-sm tabular-nums text-muted-foreground">{filteredRows.length} 个结果</p></div>
        {filteredRows.length > 0 ? <CatalogResults rows={filteredRows} /> : (
          <ActionableEmptyState
            action={query ? <Button className="min-h-11" onClick={() => setQuery("")} type="button" variant="outline">清除搜索</Button> : undefined}
            description={query ? "当前搜索条件下没有结果，请调整关键词。" : "创建首个标准 SKU 后，客户货盘和库存会在这里建立关联。"}
            kind={query ? "filtered" : "initial"}
            title={query ? "没有符合条件的 SKU" : "暂无 SKU"}
          />
        )}
      </section>
    </div>
  );
}
