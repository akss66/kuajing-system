import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { InventoryAlertLevel, InventoryWorkspaceRow } from "./inventory-workspace";

export function alertLabel(alert: InventoryAlertLevel) {
  if (alert === "CRITICAL") return "不足 30 天";
  if (alert === "WARNING") return "不足 40 天";
  if (alert === "NONE") return "库存充足";
  return "暂无基线";
}

export function alertClassName(alert: InventoryAlertLevel) {
  if (alert === "CRITICAL") return "bg-destructive/10 text-destructive";
  if (alert === "WARNING") return "bg-warning/10 text-warning";
  if (alert === "NONE") return "bg-success/10 text-success";
  return "bg-secondary text-secondary-foreground";
}

export function InventoryHealthSummary({ rows }: { rows: InventoryWorkspaceRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const locked = rows.reduce((sum, row) => sum + row.locked, 0);
  const available = rows.reduce((sum, row) => sum + row.available, 0);
  const warningCount = rows.filter((row) => row.alertLevel === "CRITICAL" || row.alertLevel === "WARNING").length;

  return (
    <section aria-label="库存健康摘要" className="border-y border-border py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div><h2 className="text-base font-semibold text-foreground">库存健康</h2><p className="mt-1 text-sm text-muted-foreground">{warningCount > 0 ? `${warningCount} 个 SKU 需要优先处理` : "当前没有低库存预警"}</p></div>
        <dl className="grid grid-cols-3 divide-x divide-border rounded-[var(--radius-control)] bg-surface-muted px-1 py-3 lg:min-w-[29rem]">
          <div className="min-w-0 px-3"><dt className="text-xs font-medium text-muted-foreground">可售库存</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{available}</dd></div>
          <div className="min-w-0 px-3"><dt className="text-xs font-medium text-muted-foreground">订单锁定</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{locked}</dd></div>
          <div className="min-w-0 px-3"><dt className="text-xs font-medium text-muted-foreground">总库存</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{total}</dd></div>
        </dl>
      </div>
    </section>
  );
}

export function LowStockQueue({ rows }: { rows: InventoryWorkspaceRow[] }) {
  const risks = rows.filter((row) => row.alertLevel === "CRITICAL" || row.alertLevel === "WARNING");
  return (
    <section aria-label="低库存队列" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-base font-semibold text-foreground"><AlertTriangle aria-hidden="true" className="size-4 text-warning" />低库存队列</h2><p className="mt-1 text-sm text-muted-foreground">按覆盖天数优先查看需要补货的 SKU。</p></div>
        <span className="text-sm tabular-nums text-muted-foreground">{risks.length} 项</span>
      </div>
      {risks.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {risks.map((row) => (
            <li className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-6" key={row.id}>
              <div className="min-w-0"><p className="truncate font-semibold tabular-nums text-foreground">{row.skuCode}</p><p className="mt-0.5 truncate text-sm text-muted-foreground">{row.name}</p></div>
              <p className="text-sm tabular-nums text-foreground">可售 {row.available} 件</p>
              <Badge className={alertClassName(row.alertLevel)} variant="secondary">{alertLabel(row.alertLevel)}</Badge>
            </li>
          ))}
        </ul>
      ) : <p className="border-y border-border py-5 text-sm text-muted-foreground" role="status">当前没有低库存预警。</p>}
    </section>
  );
}
