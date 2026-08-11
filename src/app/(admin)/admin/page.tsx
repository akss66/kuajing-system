import { count, eq, sql } from "drizzle-orm";
import { Boxes, Building2, PackageSearch, Store } from "lucide-react";

import { ExceptionQueue } from "@/components/data-workspace/exception-queue";
import { db } from "@/db/client";
import { customers, inventoryBalances, inventoryReservations, skus, stores } from "@/db/schema";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

const statConfig = [
  { icon: Building2, key: "customers", label: "合作客户", tone: "bg-info/10 text-info" },
  { icon: Store, key: "stores", label: "TEMU 店铺", tone: "bg-primary-soft text-primary-hover" },
  { icon: PackageSearch, key: "skus", label: "在售 SKU", tone: "bg-success/10 text-success" },
  { icon: Boxes, key: "available", label: "当前可售件数", tone: "bg-warning/10 text-warning" },
] as const;

export default async function AdminOverviewPage() {
  const [[customerTotal], [storeTotal], [skuTotal], balances, reservations, coverage] = await Promise.all([
    db.select({ value: count() }).from(customers).where(eq(customers.status, "ACTIVE")),
    db.select({ value: count() }).from(stores).where(eq(stores.status, "ACTIVE")),
    db.select({ value: count() }).from(skus).where(eq(skus.saleStatus, "SELLABLE")),
    db.select({ skuId: inventoryBalances.skuId, total: inventoryBalances.totalQuantity }).from(inventoryBalances),
    db
      .select({ skuId: inventoryReservations.skuId, quantity: sql<number>`sum(${inventoryReservations.quantity})`.mapWith(Number) })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.status, "ACTIVE"))
      .groupBy(inventoryReservations.skuId),
    getStockCoverageReport(),
  ]);
  const reservedBySku = new Map(reservations.map((row) => [row.skuId, row.quantity]));
  const available = balances.reduce((sum, row) => sum + row.total - (reservedBySku.get(row.skuId) ?? 0), 0);
  const lowStockCount = coverage.filter((row) => row.alertLevel === "CRITICAL").length;
  const values = { available, customers: customerTotal.value, skus: skuTotal.value, stores: storeTotal.value };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-primary">今日运营</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">运营总览</h1>
        <p className="mt-2 text-sm text-muted">查看客户、店铺、商品和货盘库存的最新状态。</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {statConfig.map((item) => (
          <article className="rounded-[var(--radius-surface)] border border-border bg-background p-5" key={item.key}>
            <div className={`flex size-9 items-center justify-center rounded-lg ${item.tone}`}>
              <item.icon aria-hidden="true" className="size-4" />
            </div>
            <p className="mt-5 text-2xl font-semibold tabular-nums text-ink">{values[item.key]}</p>
            <p className="mt-1 text-sm text-muted">{item.label}</p>
          </article>
        ))}
      </section>

      <ExceptionQueue lowStockCount={lowStockCount} />
    </div>
  );
}
