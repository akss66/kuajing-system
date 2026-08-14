import { afterEach, describe, expect, test, vi } from "vitest";

const outboxMocks = vi.hoisted(() => ({
  enqueueCargoSyncEvent: vi.fn(),
}));

vi.mock("@/modules/feishu/outbox", () => outboxMocks);

import { db } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryStocktakeBatches,
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
  setInventoryToActualCount,
} from "@/modules/inventory/service";

afterEach(async () => {
  await db.delete(auditLogs);
  await db.delete(inventoryMovements);
  await db.delete(inventoryStocktakeBatches);
  await db.delete(inventoryReservations);
  await db.delete(inventoryBalances);
  await db.delete(skus);
  await db.delete(products);
  outboxMocks.enqueueCargoSyncEvent.mockReset();
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
  test("requires a positive integer quantity and a direction-compatible structured reason", async () => {
    const sku = await createSku(3);

    await expect(
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorId: crypto.randomUUID(),
          actorType: "ADMIN",
          direction: "INCREASE",
          quantity: 0,
          reasonCode: "RESTOCK_RECEIPT",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InventoryValidationError);

    await expect(
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorId: crypto.randomUUID(),
          actorType: "ADMIN",
          direction: "INCREASE",
          quantity: 1,
          reasonCode: "OFFLINE_FULFILLMENT",
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
        direction: "INCREASE",
        quantity: 7,
        reasonCode: "OTHER",
        remark: "  Initial Ottawa stock count  ",
        skuId: sku.id,
      }),
    );

    expect(movement).toMatchObject({
      afterQuantity: 10,
      beforeQuantity: 3,
      delta: 7,
      movementType: "MANUAL_INCREASE",
    });
    const [storedMovement] = await db.select().from(inventoryMovements);
    expect(storedMovement).toMatchObject({
      reason: "其他入库",
      reasonCode: "OTHER",
      remark: "Initial Ottawa stock count",
    });
    expect(await getAvailableQuantity(db, sku.id)).toBe(10);
    const auditRows = await db.select().from(auditLogs);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "INVENTORY_ADJUSTED",
      actorId,
      entityId: sku.id,
      entityType: "SKU_INVENTORY",
      reason: "其他入库",
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
          direction: "DECREASE",
          quantity: 2,
          reasonCode: "DAMAGED_WRITE_OFF",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);
    expect(await getAvailableQuantity(db, sku.id)).toBe(1);
  });

  test("stores offline fulfillment as an admin manual decrease without an order reference", async () => {
    const sku = await createSku(8);
    const actorId = crypto.randomUUID();

    await db.transaction((tx) =>
      adjustTotalInventory(tx, {
        actorId,
        actorType: "ADMIN",
        direction: "DECREASE",
        quantity: 2,
        reasonCode: "OFFLINE_FULFILLMENT",
        remark: "线下客户自提",
        skuId: sku.id,
      }),
    );

    const [movement] = await db.select().from(inventoryMovements);
    expect(movement).toMatchObject({
      actorId,
      actorType: "ADMIN",
      delta: -2,
      movementType: "MANUAL_DECREASE",
      reason: "线下发货/人工出库",
      reasonCode: "OFFLINE_FULFILLMENT",
      referenceId: null,
      referenceType: null,
    });
  });

  test("serializes a reservation race with a decrease and preserves the locked-stock invariant", async () => {
    const sku = await createSku(5);

    const results = await Promise.allSettled([
      db.transaction((tx) =>
        reserveInventory(tx, {
          quantity: 4,
          referenceId: "racing-reservation",
          referenceType: "TEST",
          skuId: sku.id,
        }),
      ),
      db.transaction((tx) =>
        adjustTotalInventory(tx, {
          actorId: crypto.randomUUID(),
          actorType: "ADMIN",
          direction: "DECREASE",
          quantity: 2,
          reasonCode: "DAMAGED_WRITE_OFF",
          skuId: sku.id,
        }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [balance] = await db.select().from(inventoryBalances);
    const activeReservations = await db
      .select()
      .from(inventoryReservations);
    const lockedQuantity = activeReservations
      .filter((reservation) => reservation.status === "ACTIVE")
      .reduce((sum, reservation) => sum + reservation.quantity, 0);
    expect(balance.totalQuantity).toBeGreaterThanOrEqual(lockedQuantity);
  });

  test("creates one linked stocktake batch for a change and writes nothing for no change", async () => {
    const sku = await createSku(7);
    const actorId = crypto.randomUUID();

    const changed = await db.transaction((tx) =>
      setInventoryToActualCount(tx, {
        actorId,
        actorType: "ADMIN",
        actualTotalQuantity: 9,
        reasonCode: "STOCKTAKE_CORRECTION",
        remark: "  周末实盘  ",
        skuId: sku.id,
      }),
    );
    expect(changed.status).toBe("CHANGED");

    const batchesAfterChange = await db.select().from(inventoryStocktakeBatches);
    const movementsAfterChange = await db.select().from(inventoryMovements);
    const auditsAfterChange = await db.select().from(auditLogs);
    expect(batchesAfterChange).toHaveLength(1);
    expect(movementsAfterChange).toHaveLength(1);
    expect(auditsAfterChange).toHaveLength(1);
    expect(batchesAfterChange[0]).toMatchObject({ actorId, remark: "周末实盘" });
    expect(movementsAfterChange[0]).toMatchObject({
      delta: 2,
      reason: "盘点调整",
      reasonCode: "STOCKTAKE_CORRECTION",
      remark: "周末实盘",
      stocktakeBatchId: batchesAfterChange[0].id,
    });

    const unchanged = await db.transaction((tx) =>
      setInventoryToActualCount(tx, {
        actorId,
        actorType: "ADMIN",
        actualTotalQuantity: 9,
        reasonCode: "STOCKTAKE_CORRECTION",
        skuId: sku.id,
      }),
    );
    expect(unchanged).toEqual({ status: "NO_CHANGE", totalQuantity: 9 });
    expect(await db.select().from(inventoryStocktakeBatches)).toHaveLength(1);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);
    expect(await db.select().from(auditLogs)).toHaveLength(1);
  });

  test("rejects a stocktake total below active reservations without partial writes", async () => {
    const sku = await createSku(7);
    const actorId = crypto.randomUUID();
    await db.transaction((tx) =>
      reserveInventory(tx, {
        quantity: 5,
        referenceId: "protected-stocktake",
        referenceType: "TEST",
        skuId: sku.id,
      }),
    );

    await expect(
      db.transaction((tx) =>
        setInventoryToActualCount(tx, {
          actorId,
          actorType: "ADMIN",
          actualTotalQuantity: 4,
          reasonCode: "STOCKTAKE_CORRECTION",
          skuId: sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);
    expect(await db.select().from(inventoryStocktakeBatches)).toHaveLength(0);
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);
    expect(await db.select().from(auditLogs)).toHaveLength(0);
    expect((await db.select().from(inventoryBalances))[0].totalQuantity).toBe(7);
  });

  test("never enqueues Feishu cargo work for manual adjustments or stocktakes", async () => {
    const sku = await createSku(4);
    await db.transaction((tx) =>
      adjustTotalInventory(tx, {
        actorId: crypto.randomUUID(),
        actorType: "ADMIN",
        direction: "INCREASE",
        quantity: 1,
        reasonCode: "RESTOCK_RECEIPT",
        skuId: sku.id,
      }),
    );
    await db.transaction((tx) =>
      setInventoryToActualCount(tx, {
        actorId: crypto.randomUUID(),
        actorType: "ADMIN",
        actualTotalQuantity: 6,
        reasonCode: "STOCKTAKE_CORRECTION",
        skuId: sku.id,
      }),
    );

    expect(outboxMocks.enqueueCargoSyncEvent).not.toHaveBeenCalled();
  });
});
