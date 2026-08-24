import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  integrationOutbox,
  inventoryBalances,
  inventoryReservations,
  orderShipments,
  products,
  skus,
  stores,
  walletAccounts,
} from "@/db/schema";
import { checkDatabaseHealth, getOperationalHealth } from "@/modules/system/health";

describe("operational health", () => {
  const temporaryDirs = new Set<string>();

  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        order_lines,
        order_shipments,
        fulfillment_orders,
        wallet_transactions,
        wallet_accounts,
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
    for (const directory of temporaryDirs) {
      rmSync(directory, { force: true, recursive: true });
    }
    temporaryDirs.clear();
  });

  test("reports actionable counts without returning PII", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const now = new Date("2026-08-12T15:00:00.000Z");
    const [customer] = await db
      .insert(customers)
      .values({ code: `HEALTH-${suffix}`, name: "健康检查客户" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: `健康检查店铺 ${suffix}` })
      .returning();
    const [product] = await db.insert(products).values({ name: "健康检查商品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({ defaultUnitPriceFen: 100, name: "测试", productId: product.id, skuCode: `HEALTH-${suffix}` })
      .returning();
    await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 1 });
    await db.insert(inventoryReservations).values({
      quantity: 2,
      referenceId: "over-reserved",
      referenceType: "FULFILLMENT_ORDER",
      skuId: sku.id,
    });
    await db.insert(walletAccounts).values({ balanceFen: 100, customerId: customer.id });
    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        customerId: customer.id,
        orderNumber: `HEALTH-${suffix}`,
        paidAt: now,
        paymentMode: "DIRECT_OFFLINE",
        status: "SHIPPED",
        storeId: store.id,
        totalAmountFen: 100,
        totalPackageCount: 1,
        totalQuantity: 1,
      })
      .returning();
    await db.insert(orderShipments).values({
      externalOrderNo: `HEALTH-EXT-${suffix}`,
      orderId: order.id,
      recipientPayloadEncrypted: "encrypted-private-value",
      shippedAt: now,
      storeId: store.id,
    });
    await db.insert(integrationOutbox).values([
      {
        aggregateId: "failed",
        aggregateType: "TEST",
        eventType: "TEST_FAILED",
        idempotencyKey: `health-failed-${suffix}`,
        lastErrorCode: "HTTP_500",
        payload: {},
        status: "FAILED",
        target: "JIFENG",
      },
      {
        aggregateId: "stale",
        aggregateType: "TEST",
        eventType: "TEST_STALE",
        idempotencyKey: `health-stale-${suffix}`,
        lockedAt: new Date("2026-08-12T14:00:00.000Z"),
        payload: {},
        status: "PROCESSING",
        target: "FEISHU_SHEET",
      },
    ]);

    const result = await getOperationalHealth({ now });

    expect(result).toMatchObject({
      checks: {
        failedIntegrations: 1,
        overReservedSkus: 1,
        shippedWithoutTracking: 1,
        staleProcessingIntegrations: 1,
        walletMismatches: 1,
      },
      status: "DEGRADED",
    });
    expect(JSON.stringify(result)).not.toContain("encrypted-private-value");
    expect(JSON.stringify(result)).not.toContain(customer.name);
  });

  test("degrades when the worker heartbeat is stale", async () => {
    const now = new Date("2026-08-24T08:30:00.000Z");
    const directory = mkdtempSync(join(tmpdir(), "worker-health-"));
    temporaryDirs.add(directory);
    const filePath = join(directory, "worker-health.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        lastHeartbeatAt: "2026-08-24T08:05:00.000Z",
        pid: 4321,
        startedAt: "2026-08-24T07:00:00.000Z",
        state: "READY",
        version: 1,
      }),
      "utf8",
    );

    const result = await getOperationalHealth({
      now,
      workerHealth: { filePath, required: true },
    });

    expect(result).toMatchObject({
      checks: {
        workerHeartbeatFailures: 1,
      },
      status: "DEGRADED",
      worker: {
        code: "HEARTBEAT_STALE",
        healthy: false,
      },
    });
  });

  test("fails runtime health checks when worker heartbeat is required but missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-health-missing-"));
    temporaryDirs.add(directory);
    const filePath = join(directory, "missing-worker-health.json");

    await expect(
      getOperationalHealth({
        workerHealth: { filePath, required: true },
      }),
    ).resolves.toMatchObject({
      checks: {
        workerHeartbeatFailures: 1,
      },
      status: "DEGRADED",
      worker: {
        code: "INVALID_HEARTBEAT",
        healthy: false,
      },
    });
  });

  test("rejects the runtime readiness probe when a required worker heartbeat is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-health-probe-"));
    temporaryDirs.add(directory);
    const filePath = join(directory, "missing-worker-health.json");

    await expect(
      checkDatabaseHealth({
        workerHealth: { filePath, required: true },
      }),
    ).rejects.toThrow("WORKER_HEALTH_INVALID_HEARTBEAT");
  });
});
