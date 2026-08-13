import { desc, eq, sql } from "drizzle-orm";

import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import { db } from "@/db/client";
import {
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  skus,
} from "@/db/schema";
import { adjustInventoryAction } from "@/modules/inventory/actions";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

export default async function InventoryPage() {
  const [balanceRows, reservedRows, coverageRows, movementRows] = await Promise.all([
    db
      .select({
        id: skus.id,
        name: skus.name,
        skuCode: skus.skuCode,
        total: inventoryBalances.totalQuantity,
      })
      .from(inventoryBalances)
      .innerJoin(skus, eq(skus.id, inventoryBalances.skuId))
      .orderBy(desc(inventoryBalances.updatedAt)),
    db
      .select({
        quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(Number),
        skuId: inventoryReservations.skuId,
      })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.status, "ACTIVE"))
      .groupBy(inventoryReservations.skuId),
    getStockCoverageReport(),
    db
      .select({
        afterQuantity: inventoryMovements.afterQuantity,
        createdAt: inventoryMovements.createdAt,
        delta: inventoryMovements.delta,
        id: inventoryMovements.id,
        movementType: inventoryMovements.movementType,
        reason: inventoryMovements.reason,
        skuCode: skus.skuCode,
      })
      .from(inventoryMovements)
      .innerJoin(skus, eq(skus.id, inventoryMovements.skuId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(8),
  ]);

  const reservedBySku = new Map(reservedRows.map((row) => [row.skuId, row.quantity]));
  const coverageBySku = new Map(coverageRows.map((row) => [row.skuId, row]));
  const rows = balanceRows.map((row) => {
    const locked = reservedBySku.get(row.id) ?? 0;
    const coverage = coverageBySku.get(row.id);
    return {
      alertLevel: coverage?.alertLevel ?? "NO_BASELINE" as const,
      available: Math.max(0, row.total - locked),
      coverageDays: coverage?.coverageDays ?? null,
      id: row.id,
      locked,
      name: row.name,
      shippedQuantity7d: coverage?.shippedQuantity7d ?? 0,
      skuCode: row.skuCode,
      total: row.total,
    };
  });

  return (
    <InventoryWorkspace
      adjustInventoryAction={adjustInventoryAction}
      recentMovements={movementRows.map((movement) => ({
        ...movement,
        createdAt: movement.createdAt.toISOString(),
      }))}
      rows={rows}
    />
  );
}
