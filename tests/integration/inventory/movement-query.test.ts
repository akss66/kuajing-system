import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  authUsers,
  customers,
  feishuCargoMigrationRuns,
  fulfillmentOrders,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryStocktakeBatches,
  orderShipments,
  products,
  replacementRequests,
  skus,
  stores,
} from "@/db/schema";
import {
  listInventoryMovements,
  listInventorySnapshot,
} from "@/modules/inventory/read-model";

const movementId = (sequence: number) =>
  `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;

async function createMovementFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const operatorId = `inventory-operator-${suffix}`;
  await db.insert(authUsers).values({
    email: `inventory-operator-${suffix}@example.test`,
    id: operatorId,
    name: "仓库管理员王小明",
    role: "admin",
  });
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: "库存流水关联管理员",
      loginIdentifier: `inventory-mirror-${suffix}@example.test`,
    })
    .returning({ id: adminUsers.id });
  const [customer] = await db
    .insert(customers)
    .values({ code: `INV-${suffix}`, name: "库存流水客户" })
    .returning({ id: customers.id });
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `库存流水店铺-${suffix}` })
    .returning({ id: stores.id });
  const [product, secondaryProduct] = await db
    .insert(products)
    .values([
      { name: "库存流水主商品" },
      { name: "库存流水次商品" },
    ])
    .returning({ id: products.id, name: products.name });
  const [primarySku, secondarySku] = await db
    .insert(skus)
    .values([
      {
        defaultUnitPriceFen: 0,
        defaultUnitPriceMilliYuan: 0,
        name: "库存流水主 SKU",
        productId: product.id,
        skuCode: `QUERY-PRIMARY-${suffix}`,
        specification: "主规格",
      },
      {
        defaultUnitPriceFen: 0,
        defaultUnitPriceMilliYuan: 0,
        name: "库存流水次 SKU",
        productId: secondaryProduct.id,
        skuCode: `QUERY-SECONDARY-${suffix}`,
        specification: "次规格",
      },
    ])
    .returning({ id: skus.id, skuCode: skus.skuCode });
  await db.insert(inventoryBalances).values([
    { skuId: primarySku.id, totalQuantity: 50 },
    { skuId: secondarySku.id, totalQuantity: 2 },
  ]);
  await db.insert(inventoryReservations).values([
    {
      quantity: 7,
      referenceId: `active-${suffix}`,
      referenceType: "TEST",
      skuId: primarySku.id,
      status: "ACTIVE",
    },
    {
      quantity: 60,
      referenceId: `released-${suffix}`,
      referenceType: "TEST",
      skuId: primarySku.id,
      status: "RELEASED",
    },
    {
      quantity: 5,
      referenceId: `over-reserved-${suffix}`,
      referenceType: "TEST",
      skuId: secondarySku.id,
      status: "ACTIVE",
    },
  ]);

  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `INV-ORDER-${suffix}`,
      storeId: store.id,
      totalAmountFen: 0,
      totalPackageCount: 3,
      totalQuantity: 3,
    })
    .returning({ id: fulfillmentOrders.id, orderNumber: fulfillmentOrders.orderNumber });
  const [normalShipment, originalShipment, replacementShipment] = await db
    .insert(orderShipments)
    .values([
      {
        externalOrderNo: `INV-NORMAL-${suffix}`,
        kind: "NORMAL",
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-normal",
        storeId: store.id,
      },
      {
        externalOrderNo: `INV-ORIGINAL-${suffix}`,
        kind: "NORMAL",
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-original",
        storeId: store.id,
      },
      {
        externalOrderNo: `INV-REPLACEMENT-${suffix}`,
        kind: "REPLACEMENT",
        orderId: order.id,
        recipientPayloadEncrypted: "encrypted-replacement",
        storeId: store.id,
      },
    ])
    .returning({ id: orderShipments.id });
  const [replacement] = await db
    .insert(replacementRequests)
    .values({
      createdByAdminUserId: admin.id,
      orderId: order.id,
      originalShipmentId: originalShipment.id,
      reason: "运输破损补发",
      replacementShipmentId: replacementShipment.id,
    })
    .returning({ id: replacementRequests.id });
  const [feishuRun] = await db
    .insert(feishuCargoMigrationRuns)
    .values({
      createdByAdminUserId: admin.id,
      normalizedRowsJson: [],
      sourceDigest: "b".repeat(64),
      sourceRevision: 1,
      sourceSheetId: `sheet-${suffix}`,
      sourceSpreadsheetHash: "a".repeat(64),
      status: "PREFLIGHT_READY",
      summaryJson: {
        imageCount: 0,
        productCount: 0,
        skuCount: 0,
        sourceSequenceCount: 0,
        totalQuantity: 0,
      },
    })
    .returning({ id: feishuCargoMigrationRuns.id });
  const [stocktakeBatch] = await db
    .insert(inventoryStocktakeBatches)
    .values({ actorId: operatorId, remark: "月末实盘" })
    .returning({ id: inventoryStocktakeBatches.id });

  const sameCreatedAt = new Date("2026-08-14T01:00:00.000Z");
  const genericMovements = Array.from({ length: 22 }, (_, index) => ({
    actorId: operatorId,
    actorType: "ADMIN" as const,
    afterQuantity: 101 + index,
    beforeQuantity: 100 + index,
    createdAt: sameCreatedAt,
    delta: 1,
    id: movementId(index + 1),
    movementType: "MANUAL_INCREASE" as const,
    reason: "补货入库",
    reasonCode: "RESTOCK_RECEIPT" as const,
    skuId: primarySku.id,
  }));
  await db.insert(inventoryMovements).values([
    ...genericMovements,
    {
      actorId: null,
      actorType: "SYSTEM",
      afterQuantity: 49,
      beforeQuantity: 50,
      createdAt: new Date("2026-08-14T09:00:00.000Z"),
      delta: -1,
      id: movementId(901),
      movementType: "SHIPMENT",
      reason: "系统发货扣减",
      reasonCode: "SYSTEM_SHIPMENT",
      referenceId: normalShipment.id,
      referenceType: "ORDER_SHIPMENT",
      skuId: primarySku.id,
    },
    {
      actorId: null,
      actorType: "SYSTEM",
      afterQuantity: 48,
      beforeQuantity: 49,
      createdAt: new Date("2026-08-14T08:00:00.000Z"),
      delta: -1,
      id: movementId(801),
      movementType: "SHIPMENT",
      reason: "系统补发扣减",
      reasonCode: "SYSTEM_SHIPMENT",
      referenceId: replacementShipment.id,
      referenceType: "ORDER_SHIPMENT",
      skuId: primarySku.id,
    },
    {
      actorId: operatorId,
      actorType: "ADMIN",
      afterQuantity: 10,
      beforeQuantity: 0,
      createdAt: new Date("2026-08-14T07:00:00.000Z"),
      delta: 10,
      id: movementId(701),
      movementType: "MANUAL_INCREASE",
      reason: "旧飞书导入文案",
      reasonCode: "FEISHU_INITIAL_IMPORT",
      referenceId: feishuRun.id,
      referenceType: "FEISHU_CARGO_MIGRATION",
      skuId: secondarySku.id,
    },
    {
      actorId: operatorId,
      actorType: "ADMIN",
      afterQuantity: 51,
      beforeQuantity: 50,
      createdAt: new Date("2026-08-14T06:00:00.000Z"),
      delta: 1,
      id: movementId(601),
      movementType: "MANUAL_INCREASE",
      reason: "旧盘点文案",
      reasonCode: "STOCKTAKE_CORRECTION",
      skuId: primarySku.id,
      stocktakeBatchId: stocktakeBatch.id,
    },
    {
      actorId: operatorId,
      actorType: "ADMIN",
      afterQuantity: 47,
      beforeQuantity: 50,
      createdAt: new Date("2026-08-14T05:00:00.000Z"),
      delta: -3,
      id: movementId(501),
      movementType: "MANUAL_DECREASE",
      reason: "表单不能覆盖的旧文案",
      reasonCode: "OFFLINE_FULFILLMENT",
      remark: "线下仓库已领取",
      skuId: primarySku.id,
    },
    {
      actorId: `retired-admin-${suffix}`,
      actorType: "ADMIN",
      afterQuantity: 52,
      beforeQuantity: 51,
      createdAt: new Date("2026-08-14T04:00:00.000Z"),
      delta: 1,
      id: movementId(401),
      movementType: "MANUAL_INCREASE",
      reason: "历史补货",
      reasonCode: null,
      skuId: primarySku.id,
    },
    {
      actorId: null,
      actorType: "SYSTEM",
      afterQuantity: 53,
      beforeQuantity: 52,
      createdAt: new Date("2026-08-14T03:00:00.000Z"),
      delta: 1,
      id: movementId(301),
      movementType: "REVERSAL",
      reason: "旧撤销文案",
      reasonCode: "SHIPMENT_REVERSAL",
      skuId: primarySku.id,
    },
    {
      actorId: operatorId,
      actorType: "ADMIN",
      afterQuantity: 54,
      beforeQuantity: 53,
      createdAt: new Date("2026-08-14T02:00:00.000Z"),
      delta: 1,
      id: movementId(201),
      movementType: "MANUAL_INCREASE",
      reason: "未知旧系统导入",
      reasonCode: null,
      referenceId: "https://attacker.example/never-render-this-as-a-link",
      referenceType: "LEGACY_URL",
      skuId: primarySku.id,
    },
  ]);

  return {
    feishuRun,
    normalShipment,
    operatorId,
    order,
    primarySku,
    replacement,
    secondarySku,
    stocktakeBatch,
  };
}

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table
      inventory_movements,
      inventory_stocktake_batches,
      inventory_reservations,
      inventory_balances,
      replacement_requests,
      order_shipments,
      fulfillment_orders,
      feishu_cargo_migration_runs,
      auth_users,
      admin_users,
      stores,
      skus,
      products,
      customers
    restart identity cascade
  `));
});

describe("inventory movement read model", () => {
  test("returns clamped snapshot quantities with product and SKU identity", async () => {
    const fixture = await createMovementFixture();

    const primary = await listInventorySnapshot({ skuCode: fixture.primarySku.skuCode });
    const secondary = await listInventorySnapshot({
      skuCode: fixture.secondarySku.skuCode,
    });

    expect(primary).toEqual([
      expect.objectContaining({
        availableQuantity: 43,
        lockedQuantity: 7,
        productName: "库存流水主商品",
        skuCode: fixture.primarySku.skuCode,
        specification: "主规格",
        totalQuantity: 50,
      }),
    ]);
    expect(secondary).toEqual([
      expect.objectContaining({
        availableQuantity: 0,
        lockedQuantity: 5,
        productName: "库存流水次商品",
        skuCode: fixture.secondarySku.skuCode,
        totalQuantity: 2,
      }),
    ]);
  });

  test("paginates deterministically and resolves only allowlisted operators and relations", async () => {
    const fixture = await createMovementFixture();

    const firstPage = await listInventoryMovements({ page: 1, pageSize: 10 });
    const secondPage = await listInventoryMovements({ page: 2, pageSize: 10 });

    expect(firstPage).toMatchObject({
      page: 1,
      pageSize: 10,
      total: 30,
      totalPages: 3,
    });
    expect(firstPage.rows.map(({ id }) => id)).toEqual([
      movementId(901),
      movementId(801),
      movementId(701),
      movementId(601),
      movementId(501),
      movementId(401),
      movementId(301),
      movementId(201),
      movementId(22),
      movementId(21),
    ]);
    expect(secondPage.rows[0]?.id).toBe(movementId(20));

    expect(firstPage.rows.find(({ id }) => id === movementId(901))).toMatchObject({
      operator: { actorId: null, actorType: "SYSTEM", label: "系统" },
      relation: {
        href: `/admin/orders/${fixture.order.id}`,
        id: fixture.normalShipment.id,
        type: "ORDER_SHIPMENT",
      },
      source: "SYSTEM_ORDER_SHIPMENT",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(801))).toMatchObject({
      relation: {
        href: `/admin/orders/${fixture.order.id}`,
        id: fixture.replacement.id,
        type: "REPLACEMENT",
      },
      source: "SYSTEM_ORDER_SHIPMENT",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(701))).toMatchObject({
      relation: {
        href: "/admin/system/integrations",
        id: fixture.feishuRun.id,
        type: "FEISHU_MIGRATION",
      },
      source: "FEISHU_MIGRATION",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(601))).toMatchObject({
      relation: {
        href: null,
        id: fixture.stocktakeBatch.id,
        type: "STOCKTAKE_BATCH",
      },
      source: "STOCKTAKE",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(501))).toMatchObject({
      operator: {
        actorId: fixture.operatorId,
        actorType: "ADMIN",
        label: "仓库管理员王小明",
      },
      reasonCode: "OFFLINE_FULFILLMENT",
      reasonLabel: "线下发货/人工出库",
      remark: "线下仓库已领取",
      source: "ADMIN_OFFLINE_FULFILLMENT",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(401))).toMatchObject({
      operator: {
        actorType: "ADMIN",
        label: `retired-admin-${fixture.operatorId.split("-").at(-1)}`,
      },
      reasonCode: null,
      reasonLabel: "历史补货",
      source: "ADMIN_ADJUSTMENT",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(301))).toMatchObject({
      reasonLabel: "发货撤销回补",
      source: "SYSTEM_REVERSAL",
    });
    expect(firstPage.rows.find(({ id }) => id === movementId(201))).toMatchObject({
      relation: {
        href: null,
        type: "UNAVAILABLE",
      },
    });
    expect(JSON.stringify(firstPage.rows)).not.toContain("attacker.example");
  });

  test("combines SKU, time, type, operator, and typed source filters", async () => {
    const fixture = await createMovementFixture();

    const result = await listInventoryMovements({
      actorId: fixture.operatorId,
      from: new Date("2026-08-14T04:30:00.000Z"),
      movementType: "MANUAL_DECREASE",
      page: 1,
      pageSize: 500,
      skuCode: fixture.primarySku.skuCode,
      source: "ADMIN_OFFLINE_FULFILLMENT",
      to: new Date("2026-08-14T05:30:00.000Z"),
    });

    expect(result).toMatchObject({ page: 1, pageSize: 100, total: 1, totalPages: 1 });
    expect(result.rows).toEqual([
      expect.objectContaining({
        afterQuantity: 47,
        beforeQuantity: 50,
        delta: -3,
        id: movementId(501),
        source: "ADMIN_OFFLINE_FULFILLMENT",
      }),
    ]);

    await db.insert(inventoryMovements).values({
      actorId: fixture.operatorId,
      actorType: "ADMIN",
      afterQuantity: 55,
      beforeQuantity: 54,
      createdAt: new Date("2026-08-14T10:00:00.000Z"),
      delta: 1,
      id: movementId(1001),
      movementType: "MANUAL_INCREASE",
      reason: "冲突旧数据仍由盘点批次定源",
      reasonCode: "SYSTEM_SHIPMENT",
      skuId: fixture.primarySku.id,
      stocktakeBatchId: fixture.stocktakeBatch.id,
    });

    const [feishu, stocktake, systemOrderShipment] = await Promise.all([
      listInventoryMovements({ source: "FEISHU_MIGRATION" }),
      listInventoryMovements({ source: "STOCKTAKE" }),
      listInventoryMovements({ source: "SYSTEM_ORDER_SHIPMENT" }),
    ]);
    expect(feishu.rows.map(({ id }) => id)).toEqual([movementId(701)]);
    expect(stocktake.rows.map(({ id }) => id)).toEqual([
      movementId(1001),
      movementId(601),
    ]);
    expect(systemOrderShipment.rows.map(({ id }) => id)).toEqual([
      movementId(901),
      movementId(801),
    ]);
  });

  test("bounds non-finite and extreme pagination inputs", async () => {
    await createMovementFixture();

    const defaults = await listInventoryMovements({ page: Number.NaN, pageSize: Number.NaN });
    const bounded = await listInventoryMovements({
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 0,
    });

    expect(defaults).toMatchObject({ page: 1, pageSize: 20, total: 30 });
    expect(defaults.rows).toHaveLength(20);
    expect(bounded).toMatchObject({
      page: 1_000_000,
      pageSize: 1,
      rows: [],
      total: 30,
      totalPages: 30,
    });
  });
});
