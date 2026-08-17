import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  products,
  settlementBatchOrders,
  settlementBatches,
  skus,
  stores,
  walletAccounts,
} from "@/db/schema";
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";

const future = () => new Date(Date.now() + 60 * 60 * 1_000);

async function createSku(code: string, totalQuantity: number) {
  const [product] = await db
    .insert(products)
    .values({
      cargoUnitPriceMilliYuan: 1_000,
      name: `并发商品-${code}-${crypto.randomUUID()}`,
    })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 100,
      name: `并发规格-${code}`,
      productId: product.id,
      skuCode: `${code}-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity });
  return sku;
}

async function createDraft(input: {
  customerId: string;
  groups: Array<{
    name: string;
    rows: Array<{ quantity?: number; skuId: string }>;
  }>;
}) {
  const createdStores = await db
    .insert(stores)
    .values(
      input.groups.map((group) => ({
        customerId: input.customerId,
        name: `${group.name}-${crypto.randomUUID()}`,
      })),
    )
    .returning();
  const [draft] = await db
    .insert(bulkImportDrafts)
    .values({ customerId: input.customerId, expiresAt: future() })
    .returning();
  const createdGroups = await db
    .insert(bulkImportStoreGroups)
    .values(
      input.groups.map((_, index) => ({
        customerId: input.customerId,
        draftId: draft.id,
        storeId: createdStores[index].id,
      })),
    )
    .returning();

  for (const [groupIndex, group] of input.groups.entries()) {
    const [batch] = await db
      .insert(orderImportBatches)
      .values({
        customerId: input.customerId,
        expiresAt: future(),
        fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        fileSizeBytes: 1,
        originalFileName: `concurrency-${crypto.randomUUID()}.xlsx`,
        readyRows: group.rows.length,
        storeGroupId: createdGroups[groupIndex].id,
        storeId: createdStores[groupIndex].id,
        totalRows: group.rows.length,
      })
      .returning();
    await db.insert(orderImportRows).values(
      group.rows.map((row, rowIndex) => ({
        batchId: batch.id,
        externalOrderNo: `PO-${draft.id}-${groupIndex}-${rowIndex}`,
        externalSku: `EXT-${row.skuId}`,
        externalSubOrderNo: `SUB-${draft.id}-${groupIndex}-${rowIndex}`,
        quantity: row.quantity ?? 1,
        recipientPayloadEncrypted: `encrypted-${draft.id}-${groupIndex}`,
        resolvedSkuId: row.skuId,
        rowNumber: rowIndex + 2,
        status: "READY" as const,
      })),
    );
  }
  return { draft, groups: createdGroups };
}

function submissionInput(input: {
  customerId: string;
  draft: Awaited<ReturnType<typeof createDraft>>;
  key: string;
}) {
  return {
    actorUserId: `actor-${input.key}`,
    customerId: input.customerId,
    draftId: input.draft.draft.id,
    idempotencyKey: input.key,
    requestedWalletFen: 0,
    selectedGroupIds: input.draft.groups.map((group) => group.id),
  };
}

describe("bulk submission concurrency", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      do $$
      begin
        if to_regclass('public.bulk_submission_requests') is not null then
          execute 'truncate table bulk_submission_requests';
        end if;
      end $$;
    `));
    await db.execute(sql.raw(`
      truncate table
        integration_outbox,
        audit_logs,
        settlement_batch_orders,
        settlement_batches,
        order_lines,
        order_shipments,
        fulfillment_order_import_batches,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        bulk_import_store_groups,
        bulk_import_drafts,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        customer_sku_prices,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("two drafts competing for one SKU never oversell and both keep their unaffected store", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "并发批量客户" })
      .returning();
    const contested = await createSku("CONTESTED", 1);
    const firstOnly = await createSku("FIRST-ONLY", 1);
    const secondOnly = await createSku("SECOND-ONLY", 1);
    const first = await createDraft({
      customerId: customer.id,
      groups: [
        { name: "first-contested", rows: [{ skuId: contested.id }] },
        { name: "first-unaffected", rows: [{ skuId: firstOnly.id }] },
      ],
    });
    const second = await createDraft({
      customerId: customer.id,
      groups: [
        { name: "second-contested", rows: [{ skuId: contested.id }] },
        { name: "second-unaffected", rows: [{ skuId: secondOnly.id }] },
      ],
    });

    const results = await Promise.all([
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: first, key: "race-first" }),
      ),
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: second, key: "race-second" }),
      ),
    ]);

    expect(results.map((result) => result.createdOrders.length).sort()).toEqual([1, 2]);
    expect(results.flatMap((result) => result.failedGroups)).toHaveLength(1);
    expect(results.flatMap((result) => result.failedGroups)[0].status).toBe(
      "STOCK_CHANGED",
    );
    expect(results.every((result) => result.settlementBatchId !== null)).toBe(true);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(3);
    expect(await db.select().from(settlementBatches)).toHaveLength(2);
    expect(await db.select().from(settlementBatchOrders)).toHaveLength(3);
    const contestedReservations = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.skuId, contested.id));
    expect(contestedReservations).toHaveLength(1);
    expect(contestedReservations[0].quantity).toBe(1);
    for (const sku of [firstOnly, secondOnly]) {
      const reservations = await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.skuId, sku.id));
      expect(reservations).toHaveLength(1);
    }
  });

  test("opposite row order acquires overlapping SKU locks stably without deadlock", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "稳定锁序客户" })
      .returning();
    const firstSku = await createSku("LOCK-A", 1);
    const secondSku = await createSku("LOCK-B", 1);
    const first = await createDraft({
      customerId: customer.id,
      groups: [
        {
          name: "lock-first",
          rows: [{ skuId: firstSku.id }, { skuId: secondSku.id }],
        },
      ],
    });
    const second = await createDraft({
      customerId: customer.id,
      groups: [
        {
          name: "lock-second",
          rows: [{ skuId: secondSku.id }, { skuId: firstSku.id }],
        },
      ],
    });

    const settled = await Promise.allSettled([
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: first, key: "lock-first" }),
      ),
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: second, key: "lock-second" }),
      ),
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const results = settled.map((result) =>
      result.status === "fulfilled" ? result.value : neverResult(result.reason),
    );
    expect(results.map((result) => result.createdOrders.length).sort()).toEqual([0, 1]);
    expect(results.flatMap((result) => result.failedGroups).map((row) => row.status)).toEqual([
      "STOCK_CHANGED",
    ]);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(inventoryReservations)).toHaveLength(2);
  });

  test("concurrent retries of one request return one settlement and one set of orders", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "并发幂等客户" })
      .returning();
    const sku = await createSku("IDEMPOTENT", 2);
    const draft = await createDraft({
      customerId: customer.id,
      groups: [
        { name: "idempotent-a", rows: [{ skuId: sku.id }] },
        { name: "idempotent-b", rows: [{ skuId: sku.id }] },
      ],
    });
    const input = submissionInput({
      customerId: customer.id,
      draft,
      key: "concurrent-identical-request",
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => submitBulkDraft(input)),
    );

    for (const result of results) expect(result).toEqual(results[0]);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(2);
    expect(await db.select().from(settlementBatches)).toHaveLength(1);
    expect(await db.select().from(settlementBatchOrders)).toHaveLength(2);
    expect(await db.select().from(inventoryReservations)).toHaveLength(2);
  });

  test("concurrent drafts cannot both submit one cross-store sub-order", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "跨草稿冲突客户" })
      .returning();
    const firstSku = await createSku("CROSS-DRAFT-A", 1);
    const secondSku = await createSku("CROSS-DRAFT-B", 1);
    const first = await createDraft({
      customerId: customer.id,
      groups: [{ name: "cross-draft-a", rows: [{ skuId: firstSku.id }] }],
    });
    const second = await createDraft({
      customerId: customer.id,
      groups: [{ name: "cross-draft-b", rows: [{ skuId: secondSku.id }] }],
    });
    await db
      .update(orderImportRows)
      .set({ externalSubOrderNo: "SHARED-CONCURRENT-SUB-ORDER" });

    const results = await Promise.all([
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: first, key: "cross-draft-a" }),
      ),
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: second, key: "cross-draft-b" }),
      ),
    ]);

    expect(results.flatMap((result) => result.createdOrders)).toHaveLength(1);
    expect(results.flatMap((result) => result.failedGroups).map((row) => row.status)).toEqual([
      "CROSS_STORE_CONFLICT",
    ]);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(settlementBatches)).toHaveLength(1);
  });

  test("offline-only drafts do not wait for the customer's locked wallet row", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "Offline lock isolation customer" })
      .returning();
    await db.insert(walletAccounts).values({ customerId: customer.id });
    const firstSku = await createSku("OFFLINE-A", 1);
    const secondSku = await createSku("OFFLINE-B", 1);
    const first = await createDraft({
      customerId: customer.id,
      groups: [{ name: "offline-a", rows: [{ skuId: firstSku.id }] }],
    });
    const second = await createDraft({
      customerId: customer.id,
      groups: [{ name: "offline-b", rows: [{ skuId: secondSku.id }] }],
    });
    const locker = postgres(process.env.DATABASE_URL!, { max: 1 });
    let releaseWalletLock!: () => void;
    let markWalletLocked!: () => void;
    const walletLocked = new Promise<void>((resolve) => {
      markWalletLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWalletLock = resolve;
    });
    const lockTask = locker.begin(async (connection) => {
      await connection`
        select customer_id
        from wallet_accounts
        where customer_id = ${customer.id}
        for update
      `;
      markWalletLocked();
      await release;
    });
    await walletLocked;

    const submissions = Promise.all([
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: first, key: "offline-a" }),
      ),
      submitBulkDraft(
        submissionInput({ customerId: customer.id, draft: second, key: "offline-b" }),
      ),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observation: "completed" | "blocked";
    try {
      observation = await Promise.race([
        submissions.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => {
          timer = setTimeout(() => resolve("blocked"), 1_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      releaseWalletLock();
    }
    const results = await submissions;
    await lockTask;
    await locker.end();

    expect(observation).toBe("completed");
    expect(results.every((result) => result.createdOrders.length === 1)).toBe(true);
  });
});

function neverResult(reason: unknown): never {
  throw reason;
}
