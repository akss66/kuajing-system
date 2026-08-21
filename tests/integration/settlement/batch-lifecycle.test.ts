import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

// Shipping-fee arithmetic is covered by the order and bulk-submission suites.
// These settlement lifecycle fixtures intentionally isolate funding/state transitions
// from pricing policy so their small synthetic amounts remain readable.
vi.mock("@/modules/orders/pricing", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/modules/orders/pricing")
  >();
  return {
    ...actual,
    PACKAGE_SHIPPING_FEE_FEN: 0,
    calculateOrderPricing: (input: { merchandiseAmountFen: number }) => ({
      merchandiseAmountFen: input.merchandiseAmountFen,
      shippingFeeFen: 0,
      totalAmountFen: input.merchandiseAmountFen,
    }),
  };
});

import { db } from "@/db/client";
import {
  auditLogs,
  adminUsers,
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  integrationOutbox,
  orderImportBatches,
  orderImportRows,
  orderShipments,
  products,
  settlementBatchOrders,
  settlementBatches,
  settlementPaymentClaims,
  shipmentCancellationAdjustments,
  shipmentFulfillments,
  skus,
  stores,
  walletAccounts,
  walletHolds,
  walletTransactions,
} from "@/db/schema";
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";
import { cancelFulfillmentOrder } from "@/modules/orders/lifecycle";
import { getSettlementBatchAllocation } from "@/modules/settlement/batch-allocation";
import {
  expireSettlementBatches,
  prepareSettlementForPackageCancellation,
  reportSettlementPayment,
  reviewSettlementPayment,
  withdrawSettlementPayment,
} from "@/modules/settlement/batch-service";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedAllocationRead() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.execute<{ waiting: boolean }>(sql`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query ilike '%settlement_batch_orders%'
      ) as waiting
    `);
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("allocation read did not reach the coordinated table lock");
}

async function startWalletRowBlocker(customerId: string) {
  const ready = deferred();
  const released = deferred();
  let backendPid: number | null = null;
  const completion = db.transaction(async (tx) => {
    const pidRows = await tx.execute<{ backendPid: number }>(sql`
      select pg_backend_pid() as "backendPid"
    `);
    backendPid = pidRows[0].backendPid;
    await tx.execute(sql`
      select customer_id
      from wallet_accounts
      where customer_id = ${customerId}
      for update
    `);
    ready.resolve();
    await released.promise;
  });
  void completion.catch(() => ready.resolve());
  await ready.promise;
  if (backendPid === null) await completion;
  return {
    backendPid: backendPid!,
    completion,
    release: released.resolve,
  };
}

async function startOrderRowBlocker(orderId: string) {
  const ready = deferred();
  const released = deferred();
  let backendPid: number | null = null;
  const completion = db.transaction(async (tx) => {
    const pidRows = await tx.execute<{ backendPid: number }>(sql`
      select pg_backend_pid() as "backendPid"
    `);
    backendPid = pidRows[0].backendPid;
    await tx.execute(sql`
      select id from fulfillment_orders where id = ${orderId} for update
    `);
    ready.resolve();
    await released.promise;
  });
  void completion.catch(() => ready.resolve());
  await ready.promise;
  if (backendPid === null) await completion;
  return { backendPid: backendPid!, completion, release: released.resolve };
}

async function waitForLockDescendants(blockerPid: number, expectedCount: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.execute<{ waitingCount: number }>(sql`
      with recursive blocker_descendants(pid) as (
        select activity.pid
        from pg_stat_activity activity
        where ${blockerPid} = any(pg_blocking_pids(activity.pid))
        union
        select activity.pid
        from pg_stat_activity activity
        inner join blocker_descendants blocker
          on blocker.pid = any(pg_blocking_pids(activity.pid))
      )
      select count(distinct pid)::integer as "waitingCount"
      from blocker_descendants
    `);
    if ((rows[0]?.waitingCount ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expectedCount} lock descendants for backend ${blockerPid}`);
}

async function waitForWalletRowWaiters(
  blockerPid: number,
  expectedCount: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.execute<{ waitingCount: number }>(sql`
      with recursive blocker_descendants(pid) as (
        select activity.pid
        from pg_stat_activity activity
        where ${blockerPid} = any(pg_blocking_pids(activity.pid))

        union

        select activity.pid
        from pg_stat_activity activity
        inner join blocker_descendants blocker
          on blocker.pid = any(pg_blocking_pids(activity.pid))
      )
      select count(distinct activity.pid)::integer as "waitingCount"
      from pg_stat_activity activity
      inner join blocker_descendants
        on blocker_descendants.pid = activity.pid
      inner join pg_locks waiting_lock
        on waiting_lock.pid = activity.pid
       and waiting_lock.granted = false
      where activity.datname = current_database()
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and activity.query ilike '%wallet_accounts%'
        and activity.query ilike '%for update%'
    `);
    const waitingCount = rows[0]?.waitingCount ?? 0;
    if (waitingCount >= expectedCount) return waitingCount;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `expected ${expectedCount} wallet row waiters blocked by backend ${blockerPid}`,
  );
}

function expectContinuousDebitLedger(
  rows: readonly {
    afterBalanceFen: number;
    beforeBalanceFen: number;
    deltaFen: number;
  }[],
  input: { endingFen: number; startingFen: number; totalDeltaFen: number },
) {
  const byBefore = new Map(rows.map((row) => [row.beforeBalanceFen, row]));
  let balanceFen = input.startingFen;
  for (let index = 0; index < rows.length; index += 1) {
    const row = byBefore.get(balanceFen);
    expect(row).toBeDefined();
    expect(row!.afterBalanceFen).toBe(row!.beforeBalanceFen + row!.deltaFen);
    balanceFen = row!.afterBalanceFen;
  }
  expect(balanceFen).toBe(input.endingFen);
  expect(rows.reduce((total, row) => total + row.deltaFen, 0)).toBe(
    input.totalDeltaFen,
  );
}

async function expectSettlementDebitLedger(
  settlementBatchId: string,
  input: { endingFen: number; startingFen: number; totalDeltaFen: number },
) {
  const allocations = await db
    .select({
      orderId: settlementBatchOrders.orderId,
      walletAmountFen: settlementBatchOrders.walletAmountFen,
    })
    .from(settlementBatchOrders)
    .where(eq(settlementBatchOrders.settlementBatchId, settlementBatchId));
  const debits = await db
    .select({
      afterBalanceFen: walletTransactions.afterBalanceFen,
      beforeBalanceFen: walletTransactions.beforeBalanceFen,
      deltaFen: walletTransactions.deltaFen,
      orderId: walletTransactions.orderId,
    })
    .from(walletTransactions)
    .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));

  const debitByOrder = new Map(debits.map((debit) => [debit.orderId, debit]));
  expect(debits).toHaveLength(allocations.length);
  for (const allocation of allocations) {
    const debit = debitByOrder.get(allocation.orderId);
    expect(debit).toBeDefined();
    expect(debit!.deltaFen).toBe(-allocation.walletAmountFen);
  }
  expectContinuousDebitLedger(debits, input);
}

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
      .values({
        name: `结算商品-${index}-${crypto.randomUUID()}`,
      })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        cargoUnitPriceMilliYuan: price * 10,
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
        settlement_payment_claims,
        shipment_fulfillments,
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
        admin_users,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("package cancellation invalidates an unpaid mixed settlement quote and releases its wallet hold exactly once", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 500,
      reason: "包裹取消预检测试充值",
    });
    const result = await submitFixture(fixture, 150);
    const [allocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!))
      .orderBy(asc(settlementBatchOrders.totalAmountFen))
      .limit(1);
    const preparedAt = new Date("2026-08-20T08:00:00.000Z");

    const prepare = () =>
      db.transaction((tx) =>
        prepareSettlementForPackageCancellation(tx, {
          actorId: "customer-auth",
          actorType: "CUSTOMER",
          now: preparedAt,
          orderId: allocation.orderId,
          reason: "取消其中一个包裹，原统一结算报价失效",
        }),
      );
    const concurrentOutcomes = await Promise.all([prepare(), prepare()]);
    expect(concurrentOutcomes.map(({ outcome }) => outcome).sort()).toEqual([
      "ALREADY_INVALIDATED",
      "INVALIDATED",
    ]);
    expect(
      concurrentOutcomes.every(
        ({ settlementBatchId }) => settlementBatchId === result.settlementBatchId,
      ),
    ).toBe(true);

    const [batch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(batch).toMatchObject({
      closedAt: preparedAt,
      offlineAmountFen: 250,
      status: "CANCELLED",
      totalAmountFen: 400,
      walletAmountFen: 150,
    });
    const [hold] = await db
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, result.settlementBatchId!));
    expect(hold).toMatchObject({
      releasedAt: preparedAt,
      status: "RELEASED",
    });
    expect(
      (await db.select().from(fulfillmentOrders)).every(
        (order) => order.status === "PENDING_PAYMENT" && order.paymentMode === null,
      ),
    ).toBe(true);
    expect(await db.select().from(settlementPaymentClaims)).toEqual([]);
    expect(
      (await db.select().from(auditLogs)).filter(
        (row) => row.action === "SETTLEMENT_INVALIDATED_BY_PACKAGE_CANCELLATION",
      ),
    ).toHaveLength(1);
    await expect(
      reportSettlementPayment({
        actorUserId: "customer-auth",
        amountFen: 250,
        customerId: fixture.customer.id,
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_REPORTABLE" });
  });

  test("package cancellation preflight blocks a reported settlement without mutating its claim or wallet hold", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "已申报批次取消预检测试充值",
    });
    const result = await submitFixture(fixture, 200);
    const [allocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!));
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });

    await expect(
      db.transaction((tx) =>
        prepareSettlementForPackageCancellation(tx, {
          actorId: "customer-auth",
          actorType: "CUSTOMER",
          now: new Date("2026-08-20T08:00:00.000Z"),
          orderId: allocation.orderId,
          reason: "付款已申报后尝试取消包裹",
        }),
      ),
    ).rejects.toMatchObject({
      code: "SETTLEMENT_PAYMENT_REPORTED_CANCELLATION_BLOCKED",
    });
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, result.settlementBatchId!)),
    ).resolves.toEqual([{ status: "PAYMENT_REPORTED" }]);
    await expect(
      db.select({ status: settlementPaymentClaims.status }).from(settlementPaymentClaims),
    ).resolves.toEqual([{ status: "PENDING" }]);
    await expect(
      db.select({ status: walletHolds.status }).from(walletHolds),
    ).resolves.toEqual([{ status: "ACTIVE" }]);
  });

  test("admin approval rejects a reported settlement whose package was cancelled remotely", async () => {
    const fixture = await createSubmissionFixture([400]);
    const result = await submitFixture(fixture, 0);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 400,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const [allocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!));
    const [shipment] = await db
      .select()
      .from(orderShipments)
      .where(eq(orderShipments.orderId, allocation.orderId));
    await db.insert(shipmentCancellationAdjustments).values({
      actorId: null,
      actorType: "SYSTEM",
      customerId: fixture.customer.id,
      merchandiseAmountFen: 400,
      offlineAmountFen: 0,
      orderId: allocation.orderId,
      reason: "极风状态同步确认包裹已取消",
      shipmentId: shipment.id,
      shippingFeeFen: 0,
      status: "NOT_PAID",
      totalAmountFen: 400,
      walletAmountFen: 0,
    });
    const admin = await createSettlementAdmin();

    await expect(
      reviewSettlementPayment({
        adminUserId: admin.id,
        decision: "APPROVE",
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ORDERS_NOT_PENDING" });
    await expect(
      db
        .select({ status: settlementBatches.status })
        .from(settlementBatches)
        .where(eq(settlementBatches.id, result.settlementBatchId!)),
    ).resolves.toEqual([{ status: "PAYMENT_REPORTED" }]);
    await expect(
      db.select({ status: settlementPaymentClaims.status }).from(settlementPaymentClaims),
    ).resolves.toEqual([{ status: "PENDING" }]);
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
    const allocation = await getSettlementBatchAllocation(
      fixture.customer.id,
      result.settlementBatchId!,
    );
    expect(allocation).toMatchObject({
      offlineAmountFen: 0,
      status: "PAID",
      totalAmountFen: 300,
      walletAmountFen: 300,
      walletHold: null,
    });
    expect(
      allocation?.orders.map((order) => [
        order.status,
        order.totalAmountFen,
        order.walletAmountFen,
        order.offlineAmountFen,
      ]),
    ).toEqual([
      ["PAID_PENDING_FULFILLMENT", 100, 100, 0],
      ["PAID_PENDING_FULFILLMENT", 200, 200, 0],
    ]);
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
    const allocation = await getSettlementBatchAllocation(
      fixture.customer.id,
      result.settlementBatchId!,
    );
    expect(allocation).toMatchObject({
      offlineAmountFen: 100,
      status: "PENDING_PAYMENT",
      totalAmountFen: 100,
      walletAmountFen: 0,
      walletHold: null,
    });
    expect(
      allocation?.orders.map((order) => [
        order.status,
        order.totalAmountFen,
        order.walletAmountFen,
        order.offlineAmountFen,
      ]),
    ).toEqual([["PENDING_PAYMENT", 100, 0, 100]]);
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

  test("settlement allocation returns null for another customer", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    const result = await submitFixture(fixture, 0);
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "Other settlement customer" })
      .returning();

    await expect(
      getSettlementBatchAllocation(otherCustomer.id, result.settlementBatchId!),
    ).resolves.toBeNull();
    await expect(
      getSettlementBatchAllocation(fixture.customer.id, result.settlementBatchId!),
    ).resolves.toMatchObject({
      customerId: fixture.customer.id,
      id: result.settlementBatchId,
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
    await expectSettlementDebitLedger(result.settlementBatchId!, {
      endingFen: 50,
      startingFen: 200,
      totalDeltaFen: -150,
    });
  });

  test("serializes concurrent consume replays into one terminal effect", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "concurrent consume fixture",
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
    const blocker = await startWalletRowBlocker(fixture.customer.id);
    const attemptsPromise = Promise.allSettled([consume(), consume()]);
    let attempts: Awaited<typeof attemptsPromise>;
    try {
      expect(await waitForWalletRowWaiters(blocker.backendPid, 2)).toBe(2);
      blocker.release();
      attempts = await attemptsPromise;
    } finally {
      blocker.release();
      await blocker.completion;
      await attemptsPromise;
    }

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(
      true,
    );
    const [hold] = await db.select().from(walletHolds);
    expect(hold.status).toBe("CONSUMED");
    await expectSettlementDebitLedger(result.settlementBatchId!, {
      endingFen: 50,
      startingFen: 200,
      totalDeltaFen: -150,
    });
    const consumeAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "WALLET_SETTLEMENT_HOLD_CONSUMED"));
    expect(consumeAudits).toHaveLength(1);
  });

  test("allows exactly one terminal winner when consume races release", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "consume release race fixture",
    });
    const result = await submitFixture(fixture, 150);
    const blocker = await startWalletRowBlocker(fixture.customer.id);
    const attemptsPromise = Promise.allSettled([
      db.transaction((tx) =>
        consumeWalletHold(tx, {
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          settlementBatchId: result.settlementBatchId!,
        }),
      ),
      db.transaction((tx) =>
        releaseWalletHold(tx, {
          actorType: "SYSTEM",
          actorUserId: "settlement-timeout",
          customerId: fixture.customer.id,
          reason: "payment expired",
          settlementBatchId: result.settlementBatchId!,
        }),
      ),
    ]);
    let attempts: Awaited<typeof attemptsPromise>;
    try {
      expect(await waitForWalletRowWaiters(blocker.backendPid, 2)).toBe(2);
      blocker.release();
      attempts = await attemptsPromise;
    } finally {
      blocker.release();
      await blocker.completion;
      await attemptsPromise;
    }

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const [loser] = attempts.filter((attempt) => attempt.status === "rejected");
    expect(loser).toMatchObject({ reason: expect.any(WalletValidationError) });
    const [hold] = await db.select().from(walletHolds);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    const [wallet] = await db.select().from(walletAccounts);
    if (hold.status === "CONSUMED") {
      await expectSettlementDebitLedger(result.settlementBatchId!, {
        endingFen: 50,
        startingFen: 200,
        totalDeltaFen: -150,
      });
      expect(wallet.balanceFen).toBe(50);
    } else {
      expect(hold.status).toBe("RELEASED");
      expect(debits).toEqual([]);
      expect(wallet.balanceFen).toBe(200);
    }
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

    const release = (reason: string) =>
      db.transaction((tx) =>
        releaseWalletHold(tx, {
          actorType: "SYSTEM",
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          reason,
          settlementBatchId: result.settlementBatchId!,
        }),
      );
    await release("offline payment expired");
    await release("  offline payment expired  ");
    await expect(
      db.transaction((tx) =>
        releaseWalletHold(tx, {
          actorType: "SYSTEM",
          actorUserId: "settlement-admin",
          customerId: fixture.customer.id,
          reason: "customer cancelled",
          settlementBatchId: result.settlementBatchId!,
        }),
      ),
    ).rejects.toBeInstanceOf(WalletValidationError);

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

  test(
    "returns one repeatable allocation snapshot while a terminal writer commits",
    async () => {
      const fixture = await createSubmissionFixture([400]);
      await adjustWalletBalance({
        actorUserId: "wallet-admin",
        customerId: fixture.customer.id,
        deltaFen: 200,
        reason: "allocation snapshot fixture",
      });
      const result = await submitFixture(fixture, 200);
      const blockerReady = deferred();
      const releaseBlocker = deferred();
      const blocker = db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            "lock table settlement_batch_orders in access exclusive mode",
          ),
        );
        blockerReady.resolve();
        await releaseBlocker.promise;
      });
      await blockerReady.promise;

      try {
        const allocationPromise = getSettlementBatchAllocation(
          fixture.customer.id,
          result.settlementBatchId!,
        );
        await waitForBlockedAllocationRead();
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx
            .update(settlementBatches)
            .set({ paidAt: now, status: "PAID", updatedAt: now })
            .where(eq(settlementBatches.id, result.settlementBatchId!));
          await tx
            .update(walletHolds)
            .set({ consumedAt: now, status: "CONSUMED", updatedAt: now })
            .where(
              eq(walletHolds.settlementBatchId, result.settlementBatchId!),
            );
        });
        releaseBlocker.resolve();
        await blocker;
        const allocation = await allocationPromise;

        expect([
          ["PENDING_PAYMENT", "ACTIVE"],
          ["PAID", "CONSUMED"],
        ]).toContainEqual([allocation?.status, allocation?.walletHold?.status]);
      } finally {
        releaseBlocker.resolve();
        await blocker;
      }
    },
    15_000,
  );
});

async function createSettlementAdmin(status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: "结算管理员",
      loginIdentifier: `settlement-${crypto.randomUUID()}@test.local`,
      status,
    })
    .returning();
  return admin;
}

async function expectTerminalRecovery(
  settlementBatchId: string,
  expected: {
    batchStatus: "REJECTED" | "WITHDRAWN" | "EXPIRED";
    orderStatus: "CANCELLED" | "EXPIRED";
    reason: string;
  },
) {
  const [batch] = await db
    .select()
    .from(settlementBatches)
    .where(eq(settlementBatches.id, settlementBatchId));
  expect(batch).toMatchObject({
    status: expected.batchStatus,
    statusReason: expected.reason,
  });
  expect(batch.closedAt).toBeInstanceOf(Date);

  const orders = await db
    .select()
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.customerId, batch.customerId));
  expect(orders).not.toHaveLength(0);
  expect(orders.every((order) => order.status === expected.orderStatus)).toBe(true);
  expect(
    orders.every((order) =>
      expected.orderStatus === "CANCELLED"
        ? order.cancelReason === expected.reason && order.cancelledAt instanceof Date
        : order.cancelReason === null,
    ),
  ).toBe(true);

  const reservations = await db.select().from(inventoryReservations);
  const orderIds = orders.map((order) => order.id);
  const scopedReservations = reservations.filter((reservation) =>
    orderIds.includes(reservation.referenceId),
  );
  expect(scopedReservations).not.toHaveLength(0);
  expect(
    scopedReservations.every(
      (reservation) =>
        reservation.status === "RELEASED" &&
        reservation.releaseReason === expected.reason &&
        reservation.expiresAt === null,
    ),
  ).toBe(true);
  const holds = await db
    .select()
    .from(walletHolds)
    .where(eq(walletHolds.settlementBatchId, settlementBatchId));
  expect(
    holds.every(
      (hold) => hold.status === "RELEASED" && hold.releaseReason === expected.reason,
    ),
  ).toBe(true);
  expect(await db.select().from(shipmentFulfillments)).toEqual([]);
  expect(
    await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.eventType, "JIFENG_CREATE_ORDER")),
  ).toEqual([]);
}

describe("unified offline settlement lifecycle", () => {
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
        settlement_payment_claims,
        shipment_fulfillments,
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
        admin_users,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("reports the exact offline amount for the owning customer and extends every lock to twelve hours", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    const result = await submitFixture(fixture, 0);
    const reportedAt = new Date();
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "其他结算客户" })
      .returning();

    await expect(
      reportSettlementPayment({
        actorUserId: "other-customer-auth",
        amountFen: 400,
        customerId: otherCustomer.id,
        now: reportedAt,
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_FOUND" });
    await expect(
      reportSettlementPayment({
        actorUserId: "customer-auth",
        amountFen: 399,
        customerId: fixture.customer.id,
        now: reportedAt,
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });

    const first = await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 400,
      customerId: fixture.customer.id,
      note: "微信已付；不要进入审计或出站消息",
      now: reportedAt,
      settlementBatchId: result.settlementBatchId!,
    });
    const replay = await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 400,
      customerId: fixture.customer.id,
      note: "微信已付；不要进入审计或出站消息",
      now: reportedAt,
      settlementBatchId: result.settlementBatchId!,
    });

    expect(replay.claim?.id).toBe(first.claim?.id);
    expect(first).toMatchObject({
      claim: { amountFen: 400, status: "PENDING" },
      offlineAmountFen: 400,
      status: "PAYMENT_REPORTED",
    });
    const expectedDeadline = new Date(
      reportedAt.getTime() + 12 * 60 * 60 * 1000,
    );
    const orders = await db.select().from(fulfillmentOrders);
    expect(
      orders.every(
        (order) =>
          order.paymentDeclaredAt?.getTime() === reportedAt.getTime() &&
          order.lockExpiresAt?.getTime() === expectedDeadline.getTime(),
      ),
    ).toBe(true);
    const reservations = await db.select().from(inventoryReservations);
    expect(
      reservations.every(
        (reservation) => reservation.expiresAt?.getTime() === expectedDeadline.getTime(),
      ),
    ).toBe(true);
    expect(await db.select().from(settlementPaymentClaims)).toHaveLength(1);
    const serializedAudit = JSON.stringify(await db.select().from(auditLogs));
    expect(serializedAudit).not.toContain("不要进入审计");
  });

  test("does not admit an already-paid pure-wallet settlement to the offline claim flow", async () => {
    const fixture = await createSubmissionFixture([300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 300,
      reason: "纯余额测试",
    });
    const result = await submitFixture(fixture, 300);

    await expect(
      reportSettlementPayment({
        actorUserId: "customer-auth",
        amountFen: 1,
        customerId: fixture.customer.id,
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_PAID" });
    expect(await db.select().from(settlementPaymentClaims)).toEqual([]);
  });

  test("admin approval consumes one mixed-payment hold, marks all orders paid and atomically creates fulfillment outbox", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 150,
      reason: "混合结算测试",
    });
    const result = await submitFixture(fixture, 150);
    const reportedAt = new Date();
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 250,
      customerId: fixture.customer.id,
      now: reportedAt,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    const reviewedAt = new Date(reportedAt.getTime() + 30_000);

    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      now: reviewedAt,
      settlementBatchId: result.settlementBatchId!,
    });
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      now: reviewedAt,
      settlementBatchId: result.settlementBatchId!,
    });

    const [batch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(batch).toMatchObject({ paidAt: reviewedAt, status: "PAID" });
    const [claim] = await db
      .select()
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, result.settlementBatchId!));
    expect(claim).toMatchObject({
      reviewedAt,
      reviewedByAdminUserId: admin.id,
      status: "APPROVED",
    });
    const [hold] = await db
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, result.settlementBatchId!));
    expect(hold).toMatchObject({ consumedAt: reviewedAt, status: "CONSUMED" });
    const [wallet] = await db.select().from(walletAccounts);
    expect(wallet.balanceFen).toBe(0);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    expect(debits).toHaveLength(2);
    expect(debits.reduce((sum, debit) => sum + debit.deltaFen, 0)).toBe(-150);
    const orders = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.customerId, fixture.customer.id));
    expect(
      orders.every(
        (order) =>
          order.status === "PAID_PENDING_FULFILLMENT" &&
          order.paymentMode === "MIXED" &&
          order.paidAt?.getTime() === reviewedAt.getTime() &&
          order.lockExpiresAt === null,
      ),
    ).toBe(true);
    expect(
      (await db.select().from(inventoryReservations)).every(
        (reservation) => reservation.status === "ACTIVE" && reservation.expiresAt === null,
      ),
    ).toBe(true);
    expect(await db.select().from(shipmentFulfillments)).toHaveLength(2);
    const fulfillmentEvents = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.eventType, "JIFENG_CREATE_ORDER"));
    expect(fulfillmentEvents).toHaveLength(2);
    expect(
      fulfillmentEvents.every((event) => Object.keys(event.payload).join(",") === "shipmentId"),
    ).toBe(true);
  });

  test("cancelling an approved mixed order refunds its immutable wallet allocation once and neutralizes queued Jifeng work", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 150,
      reason: "mixed cancellation regression",
    });
    const result = await submitFixture(fixture, 150);
    const reportedAt = new Date();
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 250,
      customerId: fixture.customer.id,
      now: reportedAt,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      now: new Date(reportedAt.getTime() + 1_000),
      settlementBatchId: result.settlementBatchId!,
    });
    const [allocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!))
      .orderBy(asc(settlementBatchOrders.totalAmountFen))
      .limit(1);

    const cancellation = {
      actorType: "CUSTOMER" as const,
      actorUserId: "customer-auth",
      customerId: fixture.customer.id,
      orderId: allocation.orderId,
      reason: "customer cancelled one paid order",
    };
    await cancelFulfillmentOrder(cancellation);
    await cancelFulfillmentOrder(cancellation);

    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, fixture.customer.id));
    expect(wallet.balanceFen).toBe(allocation.walletAmountFen);
    const refunds = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_REFUND"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      deltaFen: allocation.walletAmountFen,
      orderId: allocation.orderId,
    });
    const cancelledWork = await db.execute<{
      fulfillmentStatus: string;
      outboxStatus: string;
    }>(sql`
      select f.status as "fulfillmentStatus", e.status as "outboxStatus"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      inner join integration_outbox e
        on e.aggregate_id = s.id::text
       and e.event_type = 'JIFENG_CREATE_ORDER'
      where s.order_id = ${allocation.orderId}
    `);
    expect(cancelledWork).toEqual([
      { fulfillmentStatus: "CANCELLED", outboxStatus: "PENDING" },
    ]);
  });

  test("uses paid mixed-batch order allocations when cancelling zero- and positive-wallet orders", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 1,
      reason: "zero allocation cancellation regression",
    });
    const result = await submitFixture(fixture, 1);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 399,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      settlementBatchId: result.settlementBatchId!,
    });
    const [zeroWalletAllocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(
        sql`${settlementBatchOrders.settlementBatchId} = ${result.settlementBatchId}
          and ${settlementBatchOrders.walletAmountFen} = 0`,
      );
    expect(zeroWalletAllocation).toBeDefined();
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(
          sql`${walletTransactions.orderId} = ${zeroWalletAllocation.orderId}
            and ${walletTransactions.transactionType} = 'ORDER_DEBIT'`,
        ),
    ).toEqual([]);

    await expect(
      cancelFulfillmentOrder({
        actorType: "CUSTOMER",
        actorUserId: "customer-auth",
        customerId: fixture.customer.id,
        orderId: zeroWalletAllocation.orderId,
        reason: "cancel zero-wallet allocation",
      }),
    ).resolves.toEqual({
      orderId: zeroWalletAllocation.orderId,
      status: "CANCELLED",
    });

    await expect(
      db
        .select({
          offlineAmountFen: shipmentCancellationAdjustments.offlineAmountFen,
          status: shipmentCancellationAdjustments.status,
          totalAmountFen: shipmentCancellationAdjustments.totalAmountFen,
          walletAmountFen: shipmentCancellationAdjustments.walletAmountFen,
        })
        .from(shipmentCancellationAdjustments)
        .where(eq(shipmentCancellationAdjustments.orderId, zeroWalletAllocation.orderId)),
    ).resolves.toEqual([
      {
        offlineAmountFen: zeroWalletAllocation.totalAmountFen,
        status: "PENDING_OFFLINE",
        totalAmountFen: zeroWalletAllocation.totalAmountFen,
        walletAmountFen: 0,
      },
    ]);
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(
          sql`${walletTransactions.orderId} = ${zeroWalletAllocation.orderId}
            and ${walletTransactions.transactionType} = 'ORDER_REFUND'`,
        ),
    ).toEqual([]);

    const [positiveWalletAllocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(
        sql`${settlementBatchOrders.settlementBatchId} = ${result.settlementBatchId}
          and ${settlementBatchOrders.walletAmountFen} > 0`,
      );
    await db
      .delete(walletTransactions)
      .where(
        sql`${walletTransactions.orderId} = ${positiveWalletAllocation.orderId}
          and ${walletTransactions.transactionType} = 'ORDER_DEBIT'`,
      );
    await expect(
      cancelFulfillmentOrder({
        actorType: "CUSTOMER",
        actorUserId: "customer-auth",
        customerId: fixture.customer.id,
        orderId: positiveWalletAllocation.orderId,
        reason: "must not refund a missing positive wallet debit",
      }),
    ).rejects.toThrow("已付款统一结算拿货单缺少匹配的钱包扣款");
    await expect(
      db
        .select()
        .from(shipmentCancellationAdjustments)
        .where(
          eq(
            shipmentCancellationAdjustments.orderId,
            positiveWalletAllocation.orderId,
          ),
        ),
    ).resolves.toEqual([]);
  });

  test("uses a zero wallet allocation when Jifeng status 9 confirms cancellation", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 1,
      reason: "status 9 zero allocation regression",
    });
    const result = await submitFixture(fixture, 1);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 399,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      settlementBatchId: result.settlementBatchId!,
    });
    const [zeroWalletAllocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(
        sql`${settlementBatchOrders.settlementBatchId} = ${result.settlementBatchId}
          and ${settlementBatchOrders.walletAmountFen} = 0`,
      );
    const [fulfillment] = await db
      .select({
        erpNo: shipmentFulfillments.erpNo,
        id: shipmentFulfillments.id,
      })
      .from(shipmentFulfillments)
      .innerJoin(
        orderShipments,
        eq(orderShipments.id, shipmentFulfillments.shipmentId),
      )
      .where(eq(orderShipments.orderId, zeroWalletAllocation.orderId));
    await db
      .update(shipmentFulfillments)
      .set({
        externalOrderNo: "JF-ZERO-WALLET-CANCEL",
        jifengStatus: 2,
        status: "FULFILLING",
        submittedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
      .where(eq(shipmentFulfillments.id, fulfillment.id));

    await expect(
      applyJifengOrderStatus({
        detail: {
          erpNo: fulfillment.erpNo,
          orderNo: "JF-ZERO-WALLET-CANCEL",
          status: 9,
        },
        now: new Date("2026-08-20T09:01:00.000Z"),
        source: "POLL",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(
      db
        .select({
          offlineAmountFen: shipmentCancellationAdjustments.offlineAmountFen,
          status: shipmentCancellationAdjustments.status,
          walletAmountFen: shipmentCancellationAdjustments.walletAmountFen,
        })
        .from(shipmentCancellationAdjustments)
        .where(eq(shipmentCancellationAdjustments.orderId, zeroWalletAllocation.orderId)),
    ).resolves.toEqual([
      {
        offlineAmountFen: zeroWalletAllocation.totalAmountFen,
        status: "PENDING_OFFLINE",
        walletAmountFen: 0,
      },
    ]);
  });

  test("cancelling an approved direct-offline order never creates a wallet refund", async () => {
    const fixture = await createSubmissionFixture([300]);
    const result = await submitFixture(fixture, 0);
    const reportedAt = new Date();
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 300,
      customerId: fixture.customer.id,
      now: reportedAt,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "APPROVE",
      settlementBatchId: result.settlementBatchId!,
    });
    const [allocation] = await db
      .select()
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!));

    await cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: admin.id,
      orderId: allocation.orderId,
      reason: "admin cancelled direct offline order",
    });

    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_REFUND")),
    ).toEqual([]);
  });

  test("rejects inactive or missing administrators without any financial mutation", async () => {
    const fixture = await createSubmissionFixture([300]);
    const result = await submitFixture(fixture, 0);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 300,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const disabledAdmin = await createSettlementAdmin("DISABLED");

    for (const adminUserId of [disabledAdmin.id, crypto.randomUUID()]) {
      await expect(
        reviewSettlementPayment({
          adminUserId,
          decision: "APPROVE",
          settlementBatchId: result.settlementBatchId!,
        }),
      ).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
    }
    const [batch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(batch.status).toBe("PAYMENT_REPORTED");
    const [claim] = await db
      .select()
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, result.settlementBatchId!));
    expect(claim.status).toBe("PENDING");
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
  });

  test("admin rejection releases the whole batch and requires one explicit reason", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "拒绝测试",
    });
    const result = await submitFixture(fixture, 200);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();

    await expect(
      reviewSettlementPayment({
        adminUserId: admin.id,
        decision: "REJECT",
        rejectionReason: "  ",
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "REJECTION_REASON_REQUIRED" });
    await reviewSettlementPayment({
      adminUserId: admin.id,
      decision: "REJECT",
      rejectionReason: "未查询到对应微信收款",
      settlementBatchId: result.settlementBatchId!,
    });

    await expectTerminalRecovery(result.settlementBatchId!, {
      batchStatus: "REJECTED",
      orderStatus: "CANCELLED",
      reason: "未查询到对应微信收款",
    });
    const [claim] = await db.select().from(settlementPaymentClaims);
    expect(claim).toMatchObject({
      rejectionReason: "未查询到对应微信收款",
      reviewedByAdminUserId: admin.id,
      status: "REJECTED",
    });
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
  });

  test("admin rejection closes a reported batch after one order was cancelled externally", async () => {
    const fixture = await createSubmissionFixture([100, 300]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "外部取消后拒绝测试",
    });
    const result = await submitFixture(fixture, 200);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();
    const [cancelledAllocation] = await db
      .select({ orderId: settlementBatchOrders.orderId })
      .from(settlementBatchOrders)
      .where(eq(settlementBatchOrders.settlementBatchId, result.settlementBatchId!))
      .orderBy(asc(settlementBatchOrders.orderId))
      .limit(1);
    await db
      .update(fulfillmentOrders)
      .set({
        cancelReason: "极风状态 9 确认取消",
        cancellationState: "ALL",
        cancelledAt: new Date(),
        status: "CANCELLED",
      })
      .where(eq(fulfillmentOrders.id, cancelledAllocation.orderId));

    const rejection = {
      adminUserId: admin.id,
      decision: "REJECT" as const,
      rejectionReason: "极风已取消其中一单，关闭未到账付款声明",
      settlementBatchId: result.settlementBatchId!,
    };
    await expect(reviewSettlementPayment(rejection)).resolves.toBeUndefined();
    await expect(reviewSettlementPayment(rejection)).resolves.toBeUndefined();

    const [batch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(batch).toMatchObject({
      status: "REJECTED",
      statusReason: rejection.rejectionReason,
    });
    const [claim] = await db
      .select()
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, result.settlementBatchId!));
    expect(claim).toMatchObject({
      rejectionReason: rejection.rejectionReason,
      status: "REJECTED",
    });
    const [hold] = await db
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, result.settlementBatchId!));
    expect(hold).toMatchObject({ status: "RELEASED" });
    const orders = await db
      .select({ status: fulfillmentOrders.status })
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.customerId, fixture.customer.id));
    expect(orders).toEqual([{ status: "CANCELLED" }, { status: "CANCELLED" }]);
    expect(
      await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
    ).toEqual([]);
  });

  test("customer withdrawal is ownership-scoped, terminal and idempotent", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "撤回测试",
    });
    const result = await submitFixture(fixture, 200);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const [otherCustomer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "越权客户" })
      .returning();
    await expect(
      withdrawSettlementPayment({
        actorUserId: "other-auth",
        customerId: otherCustomer.id,
        reason: "尝试越权撤回",
        settlementBatchId: result.settlementBatchId!,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_NOT_FOUND" });

    const withdrawal = {
      actorUserId: "customer-auth",
      customerId: fixture.customer.id,
      now: new Date(),
      reason: "客户撤回付款声明并取消本批次",
      settlementBatchId: result.settlementBatchId!,
    };
    await withdrawSettlementPayment(withdrawal);
    await withdrawSettlementPayment(withdrawal);

    await expectTerminalRecovery(result.settlementBatchId!, {
      batchStatus: "WITHDRAWN",
      orderStatus: "CANCELLED",
      reason: withdrawal.reason,
    });
    const [claim] = await db.select().from(settlementPaymentClaims);
    expect(claim).toMatchObject({
      status: "WITHDRAWN",
      withdrawalReason: withdrawal.reason,
      withdrawnAt: withdrawal.now,
    });
    const [holdReleaseAudit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "WALLET_SETTLEMENT_HOLD_RELEASED"));
    expect(holdReleaseAudit).toMatchObject({
      actorId: withdrawal.actorUserId,
      actorType: "CUSTOMER",
      entityId: result.settlementBatchId,
    });
  });

  test("expires unreported batches after two hours and reported batches after twelve hours", async () => {
    const unreportedFixture = await createSubmissionFixture([100]);
    const unreported = await submitFixture(unreportedFixture, 0);
    const [unreportedBatch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, unreported.settlementBatchId!));
    const reportedFixture = await createSubmissionFixture([200]);
    const reported = await submitFixture(reportedFixture, 0);
    const reportedAt = new Date();
    await reportSettlementPayment({
      actorUserId: "reported-customer-auth",
      amountFen: 200,
      customerId: reportedFixture.customer.id,
      now: reportedAt,
      settlementBatchId: reported.settlementBatchId!,
    });

    expect(await expireSettlementBatches(new Date(unreportedBatch.paymentDueAt.getTime() - 1))).toBe(0);
    expect(await expireSettlementBatches(new Date(unreportedBatch.paymentDueAt.getTime()))).toBe(1);
    expect(await expireSettlementBatches(new Date(reportedAt.getTime() + 12 * 60 * 60 * 1000))).toBe(1);
    expect(await expireSettlementBatches(new Date(reportedAt.getTime() + 13 * 60 * 60 * 1000))).toBe(0);

    await expectTerminalRecovery(unreported.settlementBatchId!, {
      batchStatus: "EXPIRED",
      orderStatus: "EXPIRED",
      reason: "结算批次超过 2 小时未申报付款",
    });
    await expectTerminalRecovery(reported.settlementBatchId!, {
      batchStatus: "EXPIRED",
      orderStatus: "EXPIRED",
      reason: "付款声明超过 12 小时未完成核款",
    });
    const [timedOutClaim] = await db
      .select()
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, reported.settlementBatchId!));
    expect(timedOutClaim).toMatchObject({
      rejectionReason: "付款声明超过 12 小时未完成核款",
      reviewedByAdminUserId: null,
      status: "REJECTED",
    });
    expect(timedOutClaim.reviewedAt).toBeInstanceOf(Date);
  });

  test("review and withdrawal route exact or late reported-payment deadlines through atomic system expiry", async () => {
    for (const operation of ["REVIEW", "WITHDRAW"] as const) {
      for (const lateByMs of [0, 1]) {
        const fixture = await createSubmissionFixture([250]);
        await adjustWalletBalance({
          actorUserId: "wallet-admin",
          customerId: fixture.customer.id,
          deltaFen: 100,
          reason: "deadline regression hold",
        });
        const result = await submitFixture(fixture, 100);
        const reportedAt = new Date();
        await reportSettlementPayment({
          actorUserId: "customer-auth",
          amountFen: 150,
          customerId: fixture.customer.id,
          now: reportedAt,
          settlementBatchId: result.settlementBatchId!,
        });
        const now = new Date(reportedAt.getTime() + 12 * 60 * 60 * 1000 + lateByMs);
        const attempt =
          operation === "REVIEW"
            ? reviewSettlementPayment({
                adminUserId: (await createSettlementAdmin()).id,
                decision: "APPROVE",
                now,
                settlementBatchId: result.settlementBatchId!,
              })
            : withdrawSettlementPayment({
                actorUserId: "customer-auth",
                customerId: fixture.customer.id,
                now,
                reason: "late withdrawal must expire",
                settlementBatchId: result.settlementBatchId!,
              });
        await expect(attempt).rejects.toMatchObject({
          code: "SETTLEMENT_REVIEW_DEADLINE_EXPIRED",
        });
        const [expiredBatch] = await db
          .select()
          .from(settlementBatches)
          .where(eq(settlementBatches.id, result.settlementBatchId!));
        const [expiredOrder] = await db
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.customerId, fixture.customer.id));
        const [releasedHold] = await db
          .select()
          .from(walletHolds)
          .where(eq(walletHolds.settlementBatchId, result.settlementBatchId!));
        expect(expiredBatch.status).toBe("EXPIRED");
        expect(expiredBatch.statusReason?.trim()).toBeTruthy();
        expect(expiredOrder.status).toBe("EXPIRED");
        expect(releasedHold.status).toBe("RELEASED");
        const [claim] = await db
          .select()
          .from(settlementPaymentClaims)
          .where(eq(settlementPaymentClaims.settlementBatchId, result.settlementBatchId!));
        expect(claim).toMatchObject({
          reviewedByAdminUserId: null,
          status: "REJECTED",
        });
      }
    }
  });

  test("review and withdrawal remain allowed one millisecond before the reported-payment deadline", async () => {
    for (const operation of ["REVIEW", "WITHDRAW"] as const) {
      const fixture = await createSubmissionFixture([250]);
      const result = await submitFixture(fixture, 0);
      const reportedAt = new Date();
      await reportSettlementPayment({
        actorUserId: "customer-auth",
        amountFen: 250,
        customerId: fixture.customer.id,
        now: reportedAt,
        settlementBatchId: result.settlementBatchId!,
      });
      const now = new Date(
        reportedAt.getTime() + 12 * 60 * 60 * 1000 - 1,
      );
      if (operation === "REVIEW") {
        await reviewSettlementPayment({
          adminUserId: (await createSettlementAdmin()).id,
          decision: "APPROVE",
          now,
          settlementBatchId: result.settlementBatchId!,
        });
      } else {
        await withdrawSettlementPayment({
          actorUserId: "customer-auth",
          customerId: fixture.customer.id,
          now,
          reason: "withdraw before deadline",
          settlementBatchId: result.settlementBatchId!,
        });
      }
      const [batch] = await db
        .select()
        .from(settlementBatches)
        .where(eq(settlementBatches.id, result.settlementBatchId!));
      expect(batch.status).toBe(operation === "REVIEW" ? "PAID" : "WITHDRAWN");
    }
  });

  test("concurrent timeout workers claim disjoint batches without duplicate terminal effects", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: crypto.randomUUID(), name: "worker concurrency customer" })
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "worker concurrency store" })
      .returning();
    const now = new Date();
    const batches = await db
      .insert(settlementBatches)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          batchNumber: `WORKER-${index}-${crypto.randomUUID()}`,
          customerId: customer.id,
          idempotencyKey: `worker-${index}-${crypto.randomUUID()}`,
          offlineAmountFen: 100,
          paymentDueAt: new Date(now.getTime() - 1),
          totalAmountFen: 100,
          walletAmountFen: 0,
        })),
      )
      .returning({ id: settlementBatches.id });
    const orders = await db
      .insert(fulfillmentOrders)
      .values(
        batches.map((_, index) => ({
          customerId: customer.id,
          lockExpiresAt: new Date(now.getTime() - 1),
          orderNumber: `WORKER-${index}-${crypto.randomUUID().slice(0, 8)}`,
          status: "PENDING_PAYMENT" as const,
          storeId: store.id,
          totalAmountFen: 100,
          totalPackageCount: 1,
          totalQuantity: 1,
        })),
      )
      .returning({ id: fulfillmentOrders.id });
    await db.insert(settlementBatchOrders).values(
      batches.map((batch, index) => ({
        customerId: customer.id,
        offlineAmountFen: 100,
        orderId: orders[index].id,
        settlementBatchId: batch.id,
        totalAmountFen: 100,
        walletAmountFen: 0,
      })),
    );

    const counts = await Promise.all([
      expireSettlementBatches(now),
      expireSettlementBatches(now),
    ]);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(batches.length);
    expect(await expireSettlementBatches(now)).toBe(0);
    const expiryAudits = await db
      .select({ entityId: auditLogs.entityId })
      .from(auditLogs)
      .where(eq(auditLogs.action, "SETTLEMENT_EXPIRED"));
    expect(expiryAudits).toHaveLength(batches.length);
    expect(new Set(expiryAudits.map((audit) => audit.entityId)).size).toBe(batches.length);
  });

  test("concurrent short-lived timeout workers release mixed-wallet batches across customers exactly once", async () => {
    const now = new Date();
    const settlementIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const fixture = await createSubmissionFixture([100]);
      await adjustWalletBalance({
        actorUserId: "wallet-admin",
        customerId: fixture.customer.id,
        deltaFen: 50,
        reason: `worker mixed fixture ${index}`,
      });
      const submitted = await submitFixture(fixture, 50);
      settlementIds.push(submitted.settlementBatchId!);
      await db
        .update(settlementBatches)
        .set({ paymentDueAt: new Date(now.getTime() - 1) })
        .where(eq(settlementBatches.id, submitted.settlementBatchId!));
    }

    const counts = await Promise.all([
      expireSettlementBatches(now),
      expireSettlementBatches(now),
      expireSettlementBatches(now),
    ]);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(settlementIds.length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(100);
    const holds = await db.select().from(walletHolds);
    expect(holds).toHaveLength(settlementIds.length);
    expect(holds.every((hold) => hold.status === "RELEASED")).toBe(true);
    const terminal = await db
      .select({ id: settlementBatches.id, status: settlementBatches.status })
      .from(settlementBatches);
    expect(
      terminal.filter((batch) => settlementIds.includes(batch.id)),
    ).toHaveLength(settlementIds.length);
    expect(
      terminal
        .filter((batch) => settlementIds.includes(batch.id))
        .every((batch) => batch.status === "EXPIRED"),
    ).toBe(true);
  });

  test("blocks both customer and administrator single-order cancellation while a unified claim is pending", async () => {
    const fixture = await createSubmissionFixture([300]);
    const result = await submitFixture(fixture, 0);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 300,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const [order] = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.customerId, fixture.customer.id));

    for (const actorType of ["CUSTOMER", "ADMIN"] as const) {
      await expect(
        (await import("@/modules/orders/lifecycle")).cancelFulfillmentOrder({
          actorType,
          actorUserId: `${actorType.toLowerCase()}-auth`,
          customerId: actorType === "CUSTOMER" ? fixture.customer.id : undefined,
          orderId: order.id,
          reason: "尝试单独取消",
        }),
      ).rejects.toMatchObject({
        code: "SETTLEMENT_PAYMENT_REPORTED_CANCELLATION_BLOCKED",
      });
    }
    expect((await db.select().from(fulfillmentOrders))[0].status).toBe("PENDING_PAYMENT");
  });

  test(
    "allocated cancellation contends with expiry in canonical batch-to-order order without deadlock",
    async () => {
      const fixture = await createSubmissionFixture([300]);
      const result = await submitFixture(fixture, 0);
      const [order] = await db
        .select()
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.customerId, fixture.customer.id));
      const blocker = await startOrderRowBlocker(order.id);
      const cancel = () => cancelFulfillmentOrder({
          actorType: "ADMIN",
          actorUserId: "admin-auth",
          orderId: order.id,
          reason: "race cancellation",
        });
      const compete = async () => expireSettlementBatches(
        new Date((await db.select().from(settlementBatches).where(eq(settlementBatches.id, result.settlementBatchId!)))[0].paymentDueAt.getTime()),
      );
      let cancellation!: ReturnType<typeof cancel>;
      let competing!: ReturnType<typeof compete>;
      try {
        competing = compete();
        await waitForLockDescendants(blocker.backendPid, 1);
        cancellation = cancel();
        await waitForLockDescendants(blocker.backendPid, 2);
      } finally {
        blocker.release();
        await blocker.completion;
      }

      const attempts = await Promise.allSettled([cancellation, competing]);
      expect(
        attempts.every(
          (attempt) =>
            attempt.status === "fulfilled" ||
            !("code" in (attempt.reason as object)) ||
            !["40P01", "55P03"].includes((attempt.reason as { code?: string }).code ?? ""),
        ),
      ).toBe(true);
      const [savedBatch] = await db
        .select()
        .from(settlementBatches)
        .where(eq(settlementBatches.id, result.settlementBatchId!));
      const [savedOrder] = await db
        .select()
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.id, order.id));
      expect(
        [["EXPIRED", "EXPIRED"], ["PENDING_PAYMENT", "CANCELLED"]],
      ).toContainEqual([savedBatch.status, savedOrder.status]);
    },
  );

  test("serializes simultaneous approve and withdrawal into one complete terminal outcome", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "竞态测试",
    });
    const result = await submitFixture(fixture, 200);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();

    const attempts = await Promise.allSettled([
      reviewSettlementPayment({
        adminUserId: admin.id,
        decision: "APPROVE",
        settlementBatchId: result.settlementBatchId!,
      }),
      withdrawSettlementPayment({
        actorUserId: "customer-auth",
        customerId: fixture.customer.id,
        reason: "客户在核款同时撤回",
        settlementBatchId: result.settlementBatchId!,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const [batch] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    const [hold] = await db
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, result.settlementBatchId!));
    const orders = await db
      .select()
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.customerId, fixture.customer.id));
    if (batch.status === "PAID") {
      expect(hold.status).toBe("CONSUMED");
      expect(orders.every((order) => order.status === "PAID_PENDING_FULFILLMENT")).toBe(true);
      const debits = await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
      expect(debits).toHaveLength(1);
      expect(debits[0].deltaFen).toBe(-200);
      expect(await db.select().from(shipmentFulfillments)).toHaveLength(1);
    } else {
      expect(batch.status).toBe("WITHDRAWN");
      expect(hold.status).toBe("RELEASED");
      expect(orders.every((order) => order.status === "CANCELLED")).toBe(true);
      expect(
        await db
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.transactionType, "ORDER_DEBIT")),
      ).toEqual([]);
      expect(await db.select().from(shipmentFulfillments)).toEqual([]);
    }
    const [claim] = await db
      .select()
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, result.settlementBatchId!));
    expect(
      [
        ["PAID", "APPROVED"],
        ["WITHDRAWN", "WITHDRAWN"],
      ],
    ).toContainEqual([batch.status, claim.status]);
  });

  test("serializes simultaneous admin reviews without duplicate financial effects", async () => {
    const fixture = await createSubmissionFixture([400]);
    await adjustWalletBalance({
      actorUserId: "wallet-admin",
      customerId: fixture.customer.id,
      deltaFen: 200,
      reason: "并发核款测试",
    });
    const result = await submitFixture(fixture, 200);
    await reportSettlementPayment({
      actorUserId: "customer-auth",
      amountFen: 200,
      customerId: fixture.customer.id,
      settlementBatchId: result.settlementBatchId!,
    });
    const admin = await createSettlementAdmin();

    const attempts = await Promise.allSettled([
      reviewSettlementPayment({
        adminUserId: admin.id,
        decision: "APPROVE",
        settlementBatchId: result.settlementBatchId!,
      }),
      reviewSettlementPayment({
        adminUserId: admin.id,
        decision: "APPROVE",
        settlementBatchId: result.settlementBatchId!,
      }),
    ]);

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    const debits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.transactionType, "ORDER_DEBIT"));
    expect(debits).toHaveLength(1);
    expect(debits[0].deltaFen).toBe(-200);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "SETTLEMENT_PAYMENT_APPROVED"));
    expect(audits).toHaveLength(1);
    expect(await db.select().from(shipmentFulfillments)).toHaveLength(1);
  });
});
