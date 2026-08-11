import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import { getAvailableQuantity } from "@/modules/inventory/queries";
import {
  adjustTotalInventory,
  InventoryValidationError,
  InsufficientInventoryError,
  releaseReservation,
  reserveInventory,
} from "@/modules/inventory/service";

afterEach(async () => {
  await db.delete(auditLogs);
  await db.delete(inventoryMovements);
  await db.delete(inventoryReservations);
  await db.delete(inventoryBalances);
  await db.delete(skus);
  await db.delete(products);
});

async function createSku(totalQuantity: number) {
  const [product] = await db
    .insert(products)
    .values({ name: "Inventory product" })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 690,
      name: "Inventory SKU",
      productId: product.id,
      skuCode: `INV-${crypto.randomUUID().slice(0, 12)}`,
    })
    .returning({ id: skus.id });
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity });
  return sku;
}

describe("available inventory and reservations", () => {
  test("available equals total minus active reservations", async () => {
    const sku = await createSku(10);
    await db.transaction((tx) =>
      reserveInventory(tx, {
        quantity: 4,
        referenceId: "formula-test",
        referenceType: "TEST",
        skuId: sku.id,
      }),
    );

    expect(await getAvailableQuantity(db, sku.id)).toBe(6);
  });

  test("two concurrent reservations cannot oversell the final unit", async () => {
    const sku = await createSku(1);

    const results = await Promise.allSettled([
      db.transaction((tx) =>
        reserveInventory(tx, {
          quantity: 1,
          referenceId: "concurrent-one",
          referenceType: "TEST",
          skuId: sku.id,
        }),
      ),
      db.transaction((tx) =>
        reserveInventory(tx, {
          quantity: 1,
          referenceId: "concurrent-two",
          referenceType: "TEST",
          skuId: sku.id,
        }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(InsufficientInventoryError) });
    expect(await getAvailableQuantity(db, sku.id)).toBe(0);
  });

  test("releasing an active reservation restores available inventory", async () => {
    const sku = await createSku(5);
    const reservation = await db.transaction((tx) =>
      reserveInventory(tx, {
        quantity: 3,
        referenceId: "release-test",
        referenceType: "TEST",
        skuId: sku.id,
      }),
    );

    await db.transaction((tx) =>
      releaseReservation(tx, reservation.id, "Test order cancelled"),
    );

    expect(await getAvailableQuantity(db, sku.id)).toBe(5);
  });
});

describe("manual inventory adjustments", () => {
  test("requires a non-zero integer delta and a reason", async () => {
    const sku = await createSku(3);

    await expect(
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorType: "ADMIN",
          delta: 0,
          reason: "No change",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryValidationError);

    await expect(
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorType: "ADMIN",
          delta: 1,
          reason: "   ",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryValidationError);
  });

  test("writes the balance, immutable movement and audit event atomically", async () => {
    const sku = await createSku(3);
    const actorId = crypto.randomUUID();

    const movement = await db.transaction((tx) =>
      adjustTotalInventory(tx, {
        actorId,
        actorType: "ADMIN",
        delta: 7,
        reason: "Initial Ottawa stock count",
        skuId: sku.id,
      }),
    );

    expect(movement).toMatchObject({
      afterQuantity: 10,
      beforeQuantity: 3,
      delta: 7,
      movementType: "MANUAL_INCREASE",
    });
    expect(await getAvailableQuantity(db, sku.id)).toBe(10);
    const auditRows = await db.select().from(auditLogs);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "INVENTORY_ADJUSTED",
      actorId,
      entityId: sku.id,
      entityType: "SKU_INVENTORY",
      reason: "Initial Ottawa stock count",
    });
  });

  test("cannot reduce total inventory below active reservations", async () => {
    const sku = await createSku(5);
    await db.transaction((tx) =>
      reserveInventory(tx, {
        quantity: 4,
        referenceId: "protected-stock",
        referenceType: "TEST",
        skuId: sku.id,
      }),
    );

    await expect(
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorId: crypto.randomUUID(),
          actorType: "ADMIN",
          delta: -2,
          reason: "Damaged stock",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);
    expect(await getAvailableQuantity(db, sku.id)).toBe(1);
  });
});
