import { asc, eq, sql } from "drizzle-orm";
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
  walletHolds,
  walletTransactions,
} from "@/db/schema";
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";
import { adjustWalletBalance } from "@/modules/wallet/service";

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
});
