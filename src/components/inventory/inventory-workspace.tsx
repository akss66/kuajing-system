"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { Input } from "@/components/ui/input";
import type { ManagedAction } from "@/shared/action-state";

import { InventoryAdjustmentDrawer } from "./inventory-adjustment-drawer";
import { InventoryHealthSummary, LowStockQueue } from "./inventory-overview";
import { InventoryResults, RecentMovements } from "./inventory-results";

export type InventoryAlertLevel = "CRITICAL" | "WARNING" | "NONE" | "NO_BASELINE";

export type InventoryWorkspaceRow = {
  alertLevel: InventoryAlertLevel;
  available: number;
  coverageDays: number | null;
  id: string;
  locked: number;
  name: string;
  shippedQuantity7d: number;
  skuCode: string;
  total: number;
};

export type RecentInventoryMovement = {
  afterQuantity: number;
  createdAt: string;
  delta: number;
  id: string;
  movementType: "MANUAL_INCREASE" | "MANUAL_DECREASE" | "SHIPMENT" | "REVERSAL";
  reason: string;
  skuCode: string;
};

export function InventoryWorkspace({ adjustInventoryAction, recentMovements, rows }: {
  adjustInventoryAction: ManagedAction;
  recentMovements: RecentInventoryMovement[];
  rows: InventoryWorkspaceRow[];
}) {
  const [query, setQuery] = useState("");
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return rows;
    return rows.filter((row) => [row.skuCode, row.name].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized)));
  }, [query, rows]);

  return (
    <div className="min-w-0 space-y-6" data-inventory-workspace>
      <PageHeading action={<InventoryAdjustmentDrawer action={adjustInventoryAction} rows={rows} />} breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "货盘库存" }]} description="先处理低库存风险，再核对可售、锁定、总量和最近变动；所有调整都必须填写原因。" title="货盘库存" />
      <section aria-label="库存搜索" className="border-y border-border py-4">
        <label className="relative block max-w-xl"><span className="sr-only">搜索库存 SKU</span><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索库存 SKU" className="min-h-11 pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU 或规格名称" type="search" value={query} /></label>
      </section>
      <InventoryHealthSummary rows={rows} />
      <LowStockQueue rows={rows} />
      <section aria-label="实时库存" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-foreground">实时库存</h2><p className="mt-1 text-sm text-muted-foreground">可售库存 = 总库存 − 有效订单锁定。</p></div><span className="text-sm tabular-nums text-muted-foreground">{filteredRows.length} 个结果</span></div>
        {filteredRows.length > 0 ? <InventoryResults rows={filteredRows} /> : <p className="border-y border-border py-8 text-center text-sm text-muted-foreground" role="status">没有符合搜索条件的库存 SKU。</p>}
      </section>
      <RecentMovements movements={recentMovements} />
    </div>
  );
}
