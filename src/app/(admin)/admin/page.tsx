import { count, eq, sql } from "drizzle-orm";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ExceptionQueue } from "@/components/data-workspace/exception-queue";
import { PageHeading } from "@/components/layout/page-heading";
import { db } from "@/db/client";
import { customers, inventoryBalances, inventoryReservations, skus, stores } from "@/db/schema";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

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

  return (
    <div className="space-y-5">
      <PageHeading
        description="查看客户、店铺、在售 SKU 和实时可售库存，优先处理异常待办。"
        title="运营总览"
      />

      <MetricStrip
        items={[
          { hint: "启用中的客户档案", label: "合作客户", value: String(customerTotal.value) },
          { hint: "当前可接单店铺", label: "TEMU 店铺", value: String(storeTotal.value) },
          { hint: "客户可见的标准货盘", label: "在售 SKU", value: String(skuTotal.value) },
          { hint: "总库存扣除有效锁定", label: "当前可售件数", tone: lowStockCount ? "warning" : "default", value: String(available) },
        ]}
      />

      <ExceptionQueue lowStockCount={lowStockCount} />
    </div>
  );
}
