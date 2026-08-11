import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { inventoryBalances, inventoryReservations } from "@/db/schema";

type InventoryQueryExecutor = Pick<typeof db, "select">;

export async function getReservedQuantity(
  executor: InventoryQueryExecutor,
  skuId: string,
): Promise<number> {
  const [row] = await executor
    .select({
      quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(
        Number,
      ),
    })
    .from(inventoryReservations)
    .where(
      and(
        eq(inventoryReservations.skuId, skuId),
        eq(inventoryReservations.status, "ACTIVE"),
      ),
    );

  return row?.quantity ?? 0;
}

export async function getAvailableQuantity(
  executor: InventoryQueryExecutor,
  skuId: string,
): Promise<number> {
  const [balance] = await executor
    .select({ totalQuantity: inventoryBalances.totalQuantity })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.skuId, skuId))
    .limit(1);

  if (!balance) return 0;
  return balance.totalQuantity - (await getReservedQuantity(executor, skuId));
}
