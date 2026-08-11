import { desc, eq, sql } from "drizzle-orm";

import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db/client";
import { inventoryBalances, inventoryReservations, skus } from "@/db/schema";
import { adjustInventoryAction } from "@/modules/inventory/actions";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

export default async function InventoryPage() {
  const [rows, reservedRows, coverageRows] = await Promise.all([
    db.select({ id: skus.id, skuCode: skus.skuCode, name: skus.name, total: inventoryBalances.totalQuantity }).from(inventoryBalances).innerJoin(skus, eq(skus.id, inventoryBalances.skuId)).orderBy(desc(inventoryBalances.updatedAt)),
    db.select({ skuId: inventoryReservations.skuId, quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(Number) }).from(inventoryReservations).where(eq(inventoryReservations.status, "ACTIVE")).groupBy(inventoryReservations.skuId),
    getStockCoverageReport(),
  ]);
  const reserved = new Map(reservedRows.map((row) => [row.skuId, row.quantity]));
  const coverage = new Map(coverageRows.map((row) => [row.skuId, row]));

  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">货盘库存</h1><p className="mt-2 text-sm text-muted">总库存减去有效锁定后得到客户可见的实时可售库存。</p></header>
      <ActionForm action={adjustInventoryAction} className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 lg:grid-cols-[1.3fr_0.8fr_1.7fr_auto] lg:items-end lg:p-5" submitLabel="确认调整库存">
        <label className="space-y-2 text-sm font-medium text-ink">库存 SKU<select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="skuId" required><option value="">请选择 SKU</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.skuCode}</option>)}</select></label>
        <label className="space-y-2 text-sm font-medium text-ink">调整数量<Input className="min-h-11 tabular-nums" inputMode="numeric" name="delta" placeholder="增加填正数" required /></label>
        <label className="space-y-2 text-sm font-medium text-ink">调整原因<Input className="min-h-11" maxLength={500} name="reason" placeholder="例如：首批入库 / 盘点损耗" required /></label>
      </ActionForm>
      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <DataWorkspaceToolbar description="库存调整必须填写原因，并自动记录操作前后数量。" title="实时库存" />
        <ResponsiveDataTable><Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>名称</TableHead><TableHead className="text-right">总库存</TableHead><TableHead className="text-right">订单锁定</TableHead><TableHead className="text-right">可售库存</TableHead><TableHead className="text-right">7 日出库</TableHead><TableHead className="text-right">可售天数</TableHead><TableHead>库存预警</TableHead></TableRow></TableHeader><TableBody>{rows.length ? rows.map((row) => { const locked = reserved.get(row.id) ?? 0; const available = row.total - locked; const stock = coverage.get(row.id); const alert = stock?.alertLevel ?? "NO_BASELINE"; return <TableRow key={row.id}><TableCell className="font-semibold">{row.skuCode}</TableCell><TableCell>{row.name}</TableCell><TableCell className="text-right tabular-nums">{row.total}</TableCell><TableCell className="text-right tabular-nums">{locked}</TableCell><TableCell className="text-right font-semibold tabular-nums">{available}</TableCell><TableCell className="text-right tabular-nums">{stock?.shippedQuantity7d ?? 0}</TableCell><TableCell className="text-right tabular-nums">{stock?.coverageDays == null ? "暂无基线" : `${stock.coverageDays} 天`}</TableCell><TableCell><Badge className={alert === "CRITICAL" ? "bg-danger/10 text-danger" : alert === "WARNING" ? "bg-warning/10 text-warning" : alert === "NONE" ? "bg-success/10 text-success" : "bg-surface-muted text-muted"} variant="secondary">{alert === "CRITICAL" ? "不足 30 天" : alert === "WARNING" ? "不足 40 天" : alert === "NONE" ? "充足" : "暂无消耗基线"}</Badge></TableCell></TableRow>; }) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={8}>暂无库存记录，请先创建 SKU 并录入初始库存。</TableCell></TableRow>}</TableBody></Table></ResponsiveDataTable>
      </section>
    </div>
  );
}
