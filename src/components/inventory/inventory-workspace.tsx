"use client";

import { History, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INVENTORY_MOVEMENTS_PATH } from "@/modules/inventory/movement-navigation";
import type { ManagedAction } from "@/shared/action-state";

import { InventoryHealthSummary, LowStockQueue } from "./inventory-overview";
import { InventoryResults } from "./inventory-results";

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

export function InventoryWorkspace({
  adjustInventoryAction,
  rows,
  setInventoryToActualCountAction,
}: {
  adjustInventoryAction: ManagedAction;
  rows: InventoryWorkspaceRow[];
  setInventoryToActualCountAction: ManagedAction;
}) {
  const [query, setQuery] = useState("");
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return rows;
    return rows.filter((row) =>
      [row.skuCode, row.name].some((value) =>
        value.toLocaleLowerCase("zh-CN").includes(normalized),
      ),
    );
  }, [query, rows]);

  return (
    <div className="min-w-0 space-y-6" data-inventory-workspace>
      <PageHeading
        action={
          <Button asChild className="min-h-11" variant="outline">
            <Link href={INVENTORY_MOVEMENTS_PATH}>
              <History aria-hidden="true" />
              查看库存流水
            </Link>
          </Button>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "库存管理" },
          { label: "实时库存" },
        ]}
        description="实时核对每个 SKU 的总库存、订单锁定与可售数量，并按行执行可审计的库存调整。"
        title="实时库存"
      />

      <section aria-label="库存搜索" className="border-y border-border py-4">
        <label className="relative block max-w-xl">
          <span className="sr-only">搜索库存 SKU</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索库存 SKU" className="min-h-11 pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 SKU 或规格名称" type="search" value={query} />
        </label>
      </section>
      <InventoryHealthSummary rows={rows} />
      <LowStockQueue rows={rows} />
      <section aria-label="实时库存" className="min-w-0 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div><h2 className="text-base font-semibold text-foreground">实时库存明细</h2><p className="mt-1 text-sm text-muted-foreground">可售库存 = 总库存 − 有效订单锁定。调整入口按 SKU 独立记录。</p></div>
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{filteredRows.length} 个结果</span>
        </div>
        {filteredRows.length > 0 ? (
          <InventoryResults adjustInventoryAction={adjustInventoryAction} rows={filteredRows} setInventoryToActualCountAction={setInventoryToActualCountAction} />
        ) : (
          <p className="border-y border-border py-8 text-center text-sm text-muted-foreground" role="status">没有符合搜索条件的库存 SKU。</p>
        )}
      </section>
    </div>
  );
}
