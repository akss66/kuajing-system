import { and, eq, sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
} from "@/db/schema";

import { getReservedQuantity } from "./queries";
import type {
  AdjustTotalInventoryInput,
  InventoryMovement,
  InventoryReservation,
  ReserveInventoryInput,
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
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) {
    throw new InventoryValidationError("Inventory delta must be a non-zero integer");
  }
  const reason = input.reason.trim();
  if (!reason) throw new InventoryValidationError("Adjustment reason is required");

  const balance = await lockInventoryBalance(tx, input.skuId);
  const reserved = await getReservedQuantity(tx, input.skuId);
  const afterQuantity = balance.totalQuantity + input.delta;

  if (afterQuantity < reserved) {
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
      delta: input.delta,
      movementType: input.delta > 0 ? "MANUAL_INCREASE" : "MANUAL_DECREASE",
      reason,
      remark: input.remark,
      skuId: input.skuId,
    })
    .returning({
      afterQuantity: inventoryMovements.afterQuantity,
      beforeQuantity: inventoryMovements.beforeQuantity,
      delta: inventoryMovements.delta,
      id: inventoryMovements.id,
      movementType: inventoryMovements.movementType,
      skuId: inventoryMovements.skuId,
    });

  await tx.insert(auditLogs).values({
    action: "INVENTORY_ADJUSTED",
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: { totalQuantity: afterQuantity },
    beforeJson: { totalQuantity: balance.totalQuantity },
    entityId: input.skuId,
    entityType: "SKU_INVENTORY",
    reason,
  });

  return movement;
}
