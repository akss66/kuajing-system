import { desc, eq, sql } from "drizzle-orm";

import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db/client";
import { inventoryBalances, inventoryReservations, skus } from "@/db/schema";
import { adjustInventoryAction } from "@/modules/inventory/actions";

export default async function InventoryPage() {
  const rows = await db.select({ id: skus.id, skuCode: skus.skuCode, name: skus.name, total: inventoryBalances.totalQuantity }).from(inventoryBalances).innerJoin(skus, eq(skus.id, inventoryBalances.skuId)).orderBy(desc(inventoryBalances.updatedAt));
  const reservedRows = await db.select({ skuId: inventoryReservations.skuId, quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(Number) }).from(inventoryReservations).where(eq(inventoryReservations.status, "ACTIVE")).groupBy(inventoryReservations.skuId);
  const reserved = new Map(reservedRows.map((row) => [row.skuId, row.quantity]));

  return (
    <div className="space-y-6">
      <header><h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">货盘库存</h1><p className="mt-2 text-sm text-muted">总库存减去有效锁定后得到客户可见的实时可售库存。</p></header>
      <form action={adjustInventoryAction} className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 lg:grid-cols-[1.3fr_0.8fr_1.7fr_auto] lg:items-end lg:p-5">
        <label className="space-y-2 text-sm font-medium text-ink">库存 SKU<select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="skuId" required><option value="">请选择 SKU</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.skuCode}</option>)}</select></label>
        <label className="space-y-2 text-sm font-medium text-ink">调整数量<Input className="min-h-11 tabular-nums" inputMode="numeric" name="delta" placeholder="增加填正数" required /></label>
        <label className="space-y-2 text-sm font-medium text-ink">调整原因<Input className="min-h-11" maxLength={500} name="reason" placeholder="例如：首批入库 / 盘点损耗" required /></label>
        <Button className="min-h-11 px-4" type="submit">确认调整库存</Button>
      </form>
      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <DataWorkspaceToolbar description="库存调整必须填写原因，并自动记录操作前后数量。" title="实时库存" />
        <ResponsiveDataTable><Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>名称</TableHead><TableHead className="text-right">总库存</TableHead><TableHead className="text-right">订单锁定</TableHead><TableHead className="text-right">可售库存</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{rows.length ? rows.map((row) => { const locked = reserved.get(row.id) ?? 0; const available = row.total - locked; return <TableRow key={row.id}><TableCell className="font-semibold">{row.skuCode}</TableCell><TableCell>{row.name}</TableCell><TableCell className="text-right tabular-nums">{row.total}</TableCell><TableCell className="text-right tabular-nums">{locked}</TableCell><TableCell className="text-right font-semibold tabular-nums">{available}</TableCell><TableCell><Badge className={available > 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger"} variant="secondary">{available > 0 ? "可售" : "不可售"}</Badge></TableCell></TableRow>; }) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={6}>暂无库存记录，请先创建 SKU 并录入初始库存。</TableCell></TableRow>}</TableBody></Table></ResponsiveDataTable>
      </section>
    </div>
  );
}
