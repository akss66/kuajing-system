import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
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
  walletHolds,
  walletTransactions,
} from "@/db/schema";
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";
import { getSettlementBatchAllocation } from "@/modules/settlement/batch-allocation";
import { getWalletPosition } from "@/modules/wallet/queries";
import {
  WalletInsufficientFundsError,
  WalletValidationError,
  adjustWalletBalance,
  consumeWalletHold,
  createWalletHold,
  releaseWalletHold,
} from "@/modules/wallet/service";

const future = () => new Date(Date.now() + 60 * 60 * 1_000);

async function createSubmissionFixture(prices: readonly number[]) {
  const [customer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "结算生命周期客户" })
    .returning();
  const createdStores = await db
    .insert(stores)
    .values(
      prices.map((_, index) => ({
        customerId: customer.id,
        name: `结算店铺-${index}-${crypto.randomUUID()}`,
      })),
    )
    .returning();
  const [draft] = await db
    .insert(bulkImportDrafts)
    .values({ customerId: customer.id, expiresAt: future() })
    .returning();
  const groups = await db
    .insert(bulkImportStoreGroups)
    .values(
      createdStores.map((store) => ({
        customerId: customer.id,
        draftId: draft.id,
        storeId: store.id,
      })),
    )
    .returning();

  for (const [index, price] of prices.entries()) {
    const [product] = await db
      .insert(products)
      .values({ name: `结算商品-${index}-${crypto.randomUUID()}` })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: price,
        name: `结算规格-${index}`,
        productId: product.id,
        skuCode: `SETTLE-${index}-${crypto.randomUUID()}`,
      })
      .returning();
    await db.insert(inventoryBalances).values({
      skuId: sku.id,
      totalQuantity: 1,
    });
    const [batch] = await db
      .insert(orderImportBatches)
      .values({
        customerId: customer.id,
        expiresAt: future(),
        fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        fileSizeBytes: 1,
        originalFileName: `settlement-${index}.xlsx`,
        readyRows: 1,
        storeGroupId: groups[index].id,
        storeId: createdStores[index].id,
        totalRows: 1,
      })
      .returning();
    await db.insert(orderImportRows).values({
      batchId: batch.id,
      externalOrderNo: `PO-SETTLE-${draft.id}-${index}`,
      externalSku: `EXT-SETTLE-${index}`,
      externalSubOrderNo: `SUB-SETTLE-${draft.id}-${index}`,
      quantity: 1,
      recipientPayloadEncrypted: `encrypted-settlement-${index}`,
      resolvedSkuId: sku.id,
      rowNumber: 2,
      status: "READY",
    });
  }
  return { customer, draft, groups };
}

async function submitFixture(
  fixture: Awaited<ReturnType<typeof createSubmissionFixture>>,
  requestedWalletFen: number,
) {
  return submitBulkDraft({
    actorUserId: "settlement-wallet-user",
    customerId: fixture.customer.id,
    draftId: fixture.draft.id,
    idempotencyKey: `settlement-${crypto.randomUUID()}`,
    requestedWalletFen,
    selectedGroupIds: fixture.groups.map((group) => group.id),
  });
}

describe("bulk settlement wallet lifecycle", () => {
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
        wallet_transactions,
        wallet_holds,
        wallet_accounts,
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
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("pure wallet funding debits each order and immediately marks every order paid", async () => {
    const fixture = await createSubmissionFixture([100, 200]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 500,
      reason: "纯余额批量结算充值",
    });

    const result = await submitFixture(fixture, 999);

    const [settlement] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(settlement).toMatchObject({
      offlineAmountFen: 0,
      status: "PAID",
      totalAmountFen: 300,
      walletAmountFen: 300,
    });
    expect(settlement.paidAt).toBeInstanceOf(Date);
    const allocations = await db
      .select()
      .from(settlementBatchOrders)
      .orderBy(asc(settlementBatchOrders.totalAmountFen));
    expect(
      allocations.map((row) => [
        row.totalAmountFen,
        row.walletAmountFen,
        row.offlineAmountFen,
      ]),
    ).toEqual([
      [100, 100, 0],
      [200, 200, 0],
    ]);
    const orders = await db
      .select()
      .from(fulfillmentOrders)
      .orderBy(asc(fulfillmentOrders.totalAmountFen));
    expect(
      orders.map((order) => [
        order.status,
        order.paymentMode,
        order.lockExpiresAt,
      ]),
    ).toEqual([
      ["PAID_PENDING_FULFILLMENT", "WALLET", null],
      ["PAID_PENDING_FULFILLMENT", "WALLET", null],
    ]);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    expect(debits).toHaveLength(2);
    expect(debits.map((row) => row.deltaFen).sort((a, b) => a - b)).toEqual([
      -200,
      -100,
    ]);
    expect(
      debits.every(
        (row) => row.afterBalanceFen === row.beforeBalanceFen + row.deltaFen,
      ),
    ).toBe(true);
    expect(debits.filter((row) => row.beforeBalanceFen === 500)).toHaveLength(1);
    expect(debits.filter((row) => row.afterBalanceFen === 200)).toHaveLength(1);
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, fixture.customer.id));
    expect(wallet.balanceFen).toBe(200);
    expect(await db.select().from(walletHolds)).toEqual([]);
    const reservations = await db.select().from(inventoryReservations);
    expect(reservations.every((row) => row.expiresAt === null)).toBe(true);
  });

  test("mixed funding uses current available balance for one ACTIVE hold without ledger debit", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "混合付款批量结算充值",
    });
    const [existingSettlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `EXISTING-${crypto.randomUUID()}`,
        customerId: fixture.customer.id,
        idempotencyKey: `existing-${crypto.randomUUID()}`,
        offlineAmountFen: 0,
        paymentDueAt: future(),
        totalAmountFen: 80,
        walletAmountFen: 80,
      })
      .returning();
    await db.insert(walletHolds).values({
      amountFen: 80,
      customerId: fixture.customer.id,
      settlementBatchId: existingSettlement.id,
    });

    const result = await submitFixture(fixture, 150);

    const [settlement] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(settlement).toMatchObject({
      offlineAmountFen: 280,
      status: "PENDING_PAYMENT",
      totalAmountFen: 400,
      walletAmountFen: 120,
    });
    const allocations = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, settlement.id))
      .orderBy(asc(settlementBatchOrders.totalAmountFen));
    expect(
      allocations.map((row) => [
        row.totalAmountFen,
        row.walletAmountFen,
        row.offlineAmountFen,
      ]),
    ).toEqual([
      [100, 30, 70],
      [300, 90, 210],
    ]);
    const [hold] = await db
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, settlement.id));
    expect(hold).toMatchObject({ amountFen: 120, status: "ACTIVE" });
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, fixture.customer.id));
    expect(wallet.balanceFen).toBe(200);
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
    const orders = await db.select().from(fulfillmentOrders);
    expect(orders.every((order) => order.status === "PENDING_PAYMENT")).toBe(true);
  });

  test("zero actual wallet funding creates neither hold nor debit", async () => {
    const fixture = await createSubmissionFixture([100]);

    const result = await submitFixture(fixture, 500);

    const [settlement] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(settlement).toMatchObject({
      offlineAmountFen: 100,
      status: "PENDING_PAYMENT",
      totalAmountFen: 100,
      walletAmountFen: 0,
    });
    expect(await db.select().from(walletHolds)).toEqual([]);
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
  });

  test("offline-only submission does not create a wallet account", async () => {
    const fixture = await createSubmissionFixture([100]);

    const result = await submitFixture(fixture, 0);

    const [settlement] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(settlement).toMatchObject({
      offlineAmountFen: 100,
      totalAmountFen: 100,
      walletAmountFen: 0,
    });
    expect(await db.select().from(walletAccounts)).toEqual([]);
  });

  test("reports balance, ACTIVE holds and available balance as one wallet position", async () => {
    const fixture = await createSubmissionFixture([6_000]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 10_000,
      reason: "wallet position fixture",
    });
    await submitFixture(fixture, 3_000);

    await expect(getWalletPosition(fixture.customer.id)).resolves.toEqual({
      activeHoldFen: 3_000,
      availableFen: 7_000,
      balanceFen: 10_000,
    });
  });

  test("creates a hold once when the same request is replayed", async () => {
    const fixture = await createSubmissionFixture([1_000]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 1_000,
      reason: "hold creation fixture",
    });
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `HOLD-${crypto.randomUUID()}`,
        customerId: fixture.customer.id,
        idempotencyKey: `hold-${crypto.randomUUID()}`,
        offlineAmountFen: 600,
        paymentDueAt: future(),
        totalAmountFen: 1_000,
        walletAmountFen: 400,
      })
      .returning();

    const [first, replay] = await db.transaction(async (tx) => {
      const created = await createWalletHold(tx, {
        amountFen: 400,
        customerId: fixture.customer.id,
        settlementBatchId: settlement.id,
      });
      const repeated = await createWalletHold(tx, {
        amountFen: 400,
        customerId: fixture.customer.id,
        settlementBatchId: settlement.id,
      });
      return [created, repeated] as const;
    });

    expect(replay.id).toBe(first.id);
    expect(await db.select().from(walletHolds)).toHaveLength(1);
  });

  test("refuses to reserve funds already used by another ACTIVE hold", async () => {
    const fixture = await createSubmissionFixture([1_000]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 1_000,
      reason: "unavailable hold fixture",
    });
    const settlements = await db
      .insert(settlementBatches)
      .values([
        {
          batchNumber: `HOLD-A-${crypto.randomUUID()}`,
          customerId: fixture.customer.id,
          idempotencyKey: `hold-a-${crypto.randomUUID()}`,
          offlineAmountFen: 300,
          paymentDueAt: future(),
          totalAmountFen: 1_000,
          walletAmountFen: 700,
        },
        {
          batchNumber: `HOLD-B-${crypto.randomUUID()}`,
          customerId: fixture.customer.id,
          idempotencyKey: `hold-b-${crypto.randomUUID()}`,
          offlineAmountFen: 300,
          paymentDueAt: future(),
          totalAmountFen: 1_000,
          walletAmountFen: 700,
        },
      ])
      .returning();
    await db.transaction((tx) =>
      createWalletHold(tx, {
        amountFen: 700,
        customerId: fixture.customer.id,
        settlementBatchId: settlements[0].id,
      }),
    );

    await expect(
      db.transaction((tx) =>
        createWalletHold(tx, {
          amountFen: 700,
          customerId: fixture.customer.id,
          settlementBatchId: settlements[1].id,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletInsufficientFundsError);
  });

  test("serializes competing holds so the same available balance cannot be reserved twice", async () => {
    const fixture = await createSubmissionFixture([1_000]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 1_000,
      reason: "concurrent hold fixture",
    });
    const settlements = await db
      .insert(settlementBatches)
      .values([
        {
          batchNumber: `CONCURRENT-HOLD-A-${crypto.randomUUID()}`,
          customerId: fixture.customer.id,
          idempotencyKey: `concurrent-hold-a-${crypto.randomUUID()}`,
          offlineAmountFen: 300,
          paymentDueAt: future(),
          totalAmountFen: 1_000,
          walletAmountFen: 700,
        },
        {
          batchNumber: `CONCURRENT-HOLD-B-${crypto.randomUUID()}`,
          customerId: fixture.customer.id,
          idempotencyKey: `concurrent-hold-b-${crypto.randomUUID()}`,
          offlineAmountFen: 300,
          paymentDueAt: future(),
          totalAmountFen: 1_000,
          walletAmountFen: 700,
        },
      ])
      .returning();

    const attempts = await Promise.allSettled(
      settlements.map((settlement) =>
        db.transaction((tx) =>
          createWalletHold(tx, {
            amountFen: 700,
            customerId: fixture.customer.id,
            settlementBatchId: settlement.id,
          }),
        ),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await getWalletPosition(fixture.customer.id)).toEqual({
      activeHoldFen: 700,
      availableFen: 300,
      balanceFen: 1_000,
    });
  });

  test("rejects a negative hold amount before reaching the database", async () => {
    const fixture = await createSubmissionFixture([1_000]);
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `NEGATIVE-HOLD-${crypto.randomUUID()}`,
        customerId: fixture.customer.id,
        idempotencyKey: `negative-hold-${crypto.randomUUID()}`,
        offlineAmountFen: 1_000,
        paymentDueAt: future(),
        totalAmountFen: 1_000,
        walletAmountFen: 0,
      })
      .returning();

    await expect(
      db.transaction((tx) =>
        createWalletHold(tx, {
          amountFen: -1,
          customerId: fixture.customer.id,
          settlementBatchId: settlement.id,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletValidationError);
  });

  test("consumes a mixed-payment hold exactly once and records per-order debits", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "hold consumption fixture",
    });
    const result = await submitFixture(fixture, 150);

    const consume = () =>
      db.transaction((tx) =>
        consumeWalletHold(tx, {
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          settlementBatchId: result.settlementBatchId!,
        }),
      );
    await consume();
    await consume();

    const [hold] = await db.select().from(walletHolds);
    expect(hold.status).toBe("CONSUMED");
    expect(hold.consumedAt).toBeInstanceOf(Date);
    const [wallet] = await db.select().from(walletAccounts);
    expect(wallet.balanceFen).toBe(50);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    expect(debits).toHaveLength(2);
    expect(debits.reduce((total, row) => total + row.deltaFen, 0)).toBe(-150);
  });

  test("releases a hold exactly once without changing the wallet balance", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "hold release fixture",
    });
    const result = await submitFixture(fixture, 200);

    const release = () =>
      db.transaction((tx) =>
        releaseWalletHold(tx, {
          actorType: "SYSTEM",
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          reason: "offline payment expired",
          settlementBatchId: result.settlementBatchId!,
        }),
      );
    await release();
    await release();

    const [hold] = await db.select().from(walletHolds);
    expect(hold).toMatchObject({
      releaseReason: "offline payment expired",
      status: "RELEASED",
    });
    expect(hold.releasedAt).toBeInstanceOf(Date);
    const [wallet] = await db.select().from(walletAccounts);
    expect(wallet.balanceFen).toBe(200);
    const releaseAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "WALLET_SETTLEMENT_HOLD_RELEASED"));
    expect(releaseAudits).toHaveLength(1);
    expect(releaseAudits[0].actorType).toBe("SYSTEM");
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
  });

  test("does not permit a terminal hold to transition to the other terminal state", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "terminal hold fixture",
    });
    const result = await submitFixture(fixture, 200);
    await db.transaction((tx) =>
      releaseWalletHold(tx, {
        actorUserId: "settlement-admin",
        customerId: fixture.customer.id,
        reason: "cancelled",
        settlementBatchId: result.settlementBatchId!,
      }),
    );

    await expect(
      db.transaction((tx) =>
        consumeWalletHold(tx, {
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          settlementBatchId: result.settlementBatchId!,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletValidationError);
  });

  test("returns the batch allocation with its orders and current hold state", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 150,
      reason: "allocation view fixture",
    });
    const result = await submitFixture(fixture, 150);

    const allocation = await getSettlementBatchAllocation(
      fixture.customer.id,
      result.settlementBatchId!,
    );

    expect(allocation).toMatchObject({
      offlineAmountFen: 250,
      status: "PENDING_PAYMENT",
      totalAmountFen: 400,
      walletAmountFen: 150,
      walletHold: { amountFen: 150, status: "ACTIVE" },
    });
    expect(allocation?.orders).toHaveLength(2);
    expect(
      allocation?.orders.map((order) => [
        order.totalAmountFen,
        order.walletAmountFen,
        order.offlineAmountFen,
      ]),
    ).toEqual([
      [100, 37, 63],
      [300, 113, 187],
    ]);
  });
});
