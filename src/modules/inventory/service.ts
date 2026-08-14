import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryStocktakeBatches,
} from "@/db/schema";

import { getReservedQuantity } from "./queries";
import type {
  AdjustTotalInventoryInput,
  InventoryMovement,
  InventoryReservation,
  ReserveInventoryInput,
  SetInventoryToActualCountInput,
  SetInventoryToActualCountResult,
} from "./types";
import {
  inventoryReasonLabel,
  isManualInventoryReasonCode,
} from "./types";

export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

export class InventoryBalanceNotFoundError extends Error {
  constructor(public readonly skuId: string) {
    super(`Inventory balance not found for SKU: ${skuId}`);
    this.name = "InventoryBalanceNotFoundError";
  }
}

export class InsufficientInventoryError extends Error {
  constructor(public readonly skuId: string) {
    super(`Insufficient inventory for SKU: ${skuId}`);
    this.name = "InsufficientInventoryError";
  }
}

export type InventoryGroupReservationRequest = {
  expiresAt: Date | null;
  groupId: string;
  quantityBySku: ReadonlyMap<string, number>;
  referenceId: string;
  referenceType: string;
};

export type InventoryGroupReservationResult = {
  blockedGroupIds: Set<string>;
  shortageBySku: Map<
    string,
    { availableQuantity: number; requiredQuantity: number }
  >;
};

async function lockInventoryBalance(
  tx: DbTransaction,
  skuId: string,
): Promise<{ totalQuantity: number }> {
  const rows = await tx.execute<{ totalQuantity: number }>(sql`
    select total_quantity as "totalQuantity"
    from inventory_balances
    where sku_id = ${skuId}
    for update
  `);
  const balance = rows[0];

  if (!balance) throw new InventoryBalanceNotFoundError(skuId);
  return balance;
}

function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InventoryValidationError("Quantity must be a positive integer");
  }
}

export async function reserveInventory(
  tx: DbTransaction,
  input: ReserveInventoryInput,
): Promise<InventoryReservation> {
  assertPositiveQuantity(input.quantity);
  const balance = await lockInventoryBalance(tx, input.skuId);
  const reserved = await getReservedQuantity(tx, input.skuId);

  if (balance.totalQuantity - reserved < input.quantity) {
    throw new InsufficientInventoryError(input.skuId);
  }

  const [reservation] = await tx
    .insert(inventoryReservations)
    .values({
      expiresAt: input.expiresAt,
      quantity: input.quantity,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      skuId: input.skuId,
    })
    .returning({
      id: inventoryReservations.id,
      quantity: inventoryReservations.quantity,
      skuId: inventoryReservations.skuId,
      status: inventoryReservations.status,
    });

  return reservation;
}

/**
 * Locks every requested SKU balance in stable ID order, then applies the bulk
 * submission rule: if a SKU is short, every group using it is excluded while
 * unrelated groups keep their reservations.
 */
export async function reserveInventoryForGroups(
  tx: DbTransaction,
  groups: readonly InventoryGroupReservationRequest[],
): Promise<InventoryGroupReservationResult> {
  const groupIds = groups.map((group) => group.groupId);
  if (new Set(groupIds).size !== groupIds.length) {
    throw new InventoryValidationError("Inventory reservation group IDs must be unique");
  }

  const requiredBySku = new Map<string, number>();
  const groupIdsBySku = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const [skuId, quantity] of group.quantityBySku) {
      assertPositiveQuantity(quantity);
      const required = (requiredBySku.get(skuId) ?? 0) + quantity;
      if (!Number.isSafeInteger(required)) {
        throw new InventoryValidationError("Inventory demand exceeds the safe integer range");
      }
      requiredBySku.set(skuId, required);
      const owners = groupIdsBySku.get(skuId) ?? new Set<string>();
      owners.add(group.groupId);
      groupIdsBySku.set(skuId, owners);
    }
  }

  const skuIds = [...requiredBySku.keys()].sort();
  if (skuIds.length === 0) {
    return { blockedGroupIds: new Set(), shortageBySku: new Map() };
  }

  const balances = await tx
    .select({
      skuId: inventoryBalances.skuId,
      totalQuantity: inventoryBalances.totalQuantity,
    })
    .from(inventoryBalances)
    .where(inArray(inventoryBalances.skuId, skuIds))
    .orderBy(asc(inventoryBalances.skuId))
    .for("update");
  const totalBySku = new Map(
    balances.map((balance) => [balance.skuId, balance.totalQuantity]),
  );
  const reservedRows = await tx
    .select({
      quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`.mapWith(
        Number,
      ),
      skuId: inventoryReservations.skuId,
    })
    .from(inventoryReservations)
    .where(
      and(
        inArray(inventoryReservations.skuId, skuIds),
        eq(inventoryReservations.status, "ACTIVE"),
      ),
    )
    .groupBy(inventoryReservations.skuId);
  const reservedBySku = new Map(
    reservedRows.map((row) => [row.skuId, row.quantity]),
  );

  const blockedGroupIds = new Set<string>();
  const shortageBySku = new Map<
    string,
    { availableQuantity: number; requiredQuantity: number }
  >();
  for (const skuId of skuIds) {
    const availableQuantity = Math.max(
      0,
      (totalBySku.get(skuId) ?? 0) - (reservedBySku.get(skuId) ?? 0),
    );
    const requiredQuantity = requiredBySku.get(skuId)!;
    if (requiredQuantity <= availableQuantity) continue;
    shortageBySku.set(skuId, { availableQuantity, requiredQuantity });
    for (const groupId of groupIdsBySku.get(skuId) ?? []) {
      blockedGroupIds.add(groupId);
    }
  }

  const reservationValues = groups
    .filter((group) => !blockedGroupIds.has(group.groupId))
    .flatMap((group) =>
      [...group.quantityBySku]
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([skuId, quantity]) => ({
          expiresAt: group.expiresAt,
          quantity,
          referenceId: group.referenceId,
          referenceType: group.referenceType,
          skuId,
        })),
    );
  if (reservationValues.length > 0) {
    await tx.insert(inventoryReservations).values(reservationValues);
  }

  return { blockedGroupIds, shortageBySku };
}

export async function releaseReservation(
  tx: DbTransaction,
  reservationId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) {
    throw new InventoryValidationError("Release reason is required");
  }

  const rows = await tx.execute<{ status: string }>(sql`
    select status
    from inventory_reservations
    where id = ${reservationId}
    for update
  `);
  const reservation = rows[0];
  if (!reservation || reservation.status !== "ACTIVE") return;

  await tx
    .update(inventoryReservations)
    .set({
      releaseReason: reason.trim(),
      status: "RELEASED",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryReservations.id, reservationId),
        eq(inventoryReservations.status, "ACTIVE"),
      ),
    );
}

export async function adjustTotalInventory(
  tx: DbTransaction,
  input: AdjustTotalInventoryInput,
): Promise<InventoryMovement> {
  if (
    input.actorType !== "ADMIN" ||
    typeof input.actorId !== "string" ||
    !input.actorId.trim()
  ) {
    throw new InventoryValidationError("Manual adjustment requires an administrator");
  }
  assertPositiveQuantity(input.quantity);
  if (!isManualInventoryReasonCode(input.direction, input.reasonCode)) {
    throw new InventoryValidationError(
      "Inventory reason is not allowed for this adjustment direction",
    );
  }
  const delta = input.direction === "INCREASE" ? input.quantity : -input.quantity;
  const reason = inventoryReasonLabel(input.reasonCode, input.direction);
  const remark = normalizedRemark(input.remark);

  const balance = await lockInventoryBalance(tx, input.skuId);
  const reserved = await getReservedQuantity(tx, input.skuId);
  const afterQuantity = balance.totalQuantity + delta;

  if (!Number.isSafeInteger(afterQuantity) || afterQuantity < reserved) {
    throw new InsufficientInventoryError(input.skuId);
  }

  await tx
    .update(inventoryBalances)
    .set({ totalQuantity: afterQuantity, updatedAt: new Date() })
    .where(eq(inventoryBalances.skuId, input.skuId));

  const [movement] = await tx
    .insert(inventoryMovements)
    .values({
      actorId: input.actorId,
      actorType: input.actorType,
      afterQuantity,
      beforeQuantity: balance.totalQuantity,
      delta,
      movementType: input.direction === "INCREASE" ? "MANUAL_INCREASE" : "MANUAL_DECREASE",
      reason,
      reasonCode: input.reasonCode,
      remark,
      skuId: input.skuId,
    })
    .returning({
      afterQuantity: inventoryMovements.afterQuantity,
      beforeQuantity: inventoryMovements.beforeQuantity,
      delta: inventoryMovements.delta,
      id: inventoryMovements.id,
      movementType: inventoryMovements.movementType,
      reasonCode: inventoryMovements.reasonCode,
      remark: inventoryMovements.remark,
      skuId: inventoryMovements.skuId,
      stocktakeBatchId: inventoryMovements.stocktakeBatchId,
    });

  await tx.insert(auditLogs).values({
    action: "INVENTORY_ADJUSTED",
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: {
      delta,
      reasonCode: input.reasonCode,
      remark,
      totalQuantity: afterQuantity,
    },
    beforeJson: { totalQuantity: balance.totalQuantity },
    entityId: input.skuId,
    entityType: "SKU_INVENTORY",
    reason,
  });

  return movement;
}

function normalizedRemark(remark: string | null | undefined): string | null {
  const normalized = remark?.trim();
  if (!normalized) return null;
  if (normalized.length > 1000) {
    throw new InventoryValidationError("Inventory remark is too long");
  }
  return normalized;
}

export async function setInventoryToActualCount(
  tx: DbTransaction,
  input: SetInventoryToActualCountInput,
): Promise<SetInventoryToActualCountResult> {
  if (
    input.actorType !== "ADMIN" ||
    typeof input.actorId !== "string" ||
    !input.actorId.trim()
  ) {
    throw new InventoryValidationError("Stocktake requires an administrator");
  }
  if (
    !Number.isSafeInteger(input.actualTotalQuantity) ||
    input.actualTotalQuantity < 0
  ) {
    throw new InventoryValidationError(
      "Actual inventory total must be a non-negative integer",
    );
  }
  if (input.reasonCode !== "STOCKTAKE_CORRECTION") {
    throw new InventoryValidationError("Stocktake requires its structured reason");
  }
  const remark = normalizedRemark(input.remark);
  const balance = await lockInventoryBalance(tx, input.skuId);
  if (balance.totalQuantity === input.actualTotalQuantity) {
    return { status: "NO_CHANGE", totalQuantity: balance.totalQuantity };
  }
  const reserved = await getReservedQuantity(tx, input.skuId);
  if (input.actualTotalQuantity < reserved) {
    throw new InsufficientInventoryError(input.skuId);
  }

  const reason = inventoryReasonLabel(input.reasonCode);
  const delta = input.actualTotalQuantity - balance.totalQuantity;
  const [batch] = await tx
    .insert(inventoryStocktakeBatches)
    .values({ actorId: input.actorId, remark })
    .returning({ id: inventoryStocktakeBatches.id });

  await tx
    .update(inventoryBalances)
    .set({ totalQuantity: input.actualTotalQuantity, updatedAt: new Date() })
    .where(eq(inventoryBalances.skuId, input.skuId));

  const [movement] = await tx
    .insert(inventoryMovements)
    .values({
      actorId: input.actorId,
      actorType: input.actorType,
      afterQuantity: input.actualTotalQuantity,
      beforeQuantity: balance.totalQuantity,
      delta,
      movementType: delta > 0 ? "MANUAL_INCREASE" : "MANUAL_DECREASE",
      reason,
      reasonCode: input.reasonCode,
      remark,
      skuId: input.skuId,
      stocktakeBatchId: batch.id,
    })
    .returning({
      afterQuantity: inventoryMovements.afterQuantity,
      beforeQuantity: inventoryMovements.beforeQuantity,
      delta: inventoryMovements.delta,
      id: inventoryMovements.id,
      movementType: inventoryMovements.movementType,
      reasonCode: inventoryMovements.reasonCode,
      remark: inventoryMovements.remark,
      skuId: inventoryMovements.skuId,
      stocktakeBatchId: inventoryMovements.stocktakeBatchId,
    });

  await tx.insert(auditLogs).values({
    action: "INVENTORY_ADJUSTED",
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: {
      delta,
      reasonCode: input.reasonCode,
      remark,
      stocktakeBatchId: batch.id,
      totalQuantity: input.actualTotalQuantity,
    },
    beforeJson: { totalQuantity: balance.totalQuantity },
    entityId: input.skuId,
    entityType: "SKU_INVENTORY",
    reason,
  });

  return {
    movement,
    status: "CHANGED",
    stocktakeBatchId: batch.id,
  };
}
