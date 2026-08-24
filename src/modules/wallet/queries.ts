import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  settlementBatches,
  walletAccounts,
  walletHolds,
  walletTransactions,
} from "@/db/schema";

import {
  publicWalletHoldReleaseReason,
  publicWalletTransactionReason,
} from "./public-labels";

export async function getWalletPosition(customerId: string): Promise<{
  activeHoldFen: number;
  availableFen: number;
  balanceFen: number;
}> {
  const [position] = await db
    .select({
      activeHoldFen:
        sql<number>`coalesce(sum(${walletHolds.amountFen}) filter (where ${walletHolds.status} = 'ACTIVE'), 0)`.mapWith(
          Number,
        ),
      balanceFen: sql<number>`coalesce(${walletAccounts.balanceFen}, 0)`.mapWith(
        Number,
      ),
    })
    .from(customers)
    .leftJoin(walletAccounts, eq(walletAccounts.customerId, customers.id))
    .leftJoin(walletHolds, eq(walletHolds.customerId, customers.id))
    .where(eq(customers.id, customerId))
    .groupBy(walletAccounts.balanceFen)
    .limit(1);
  const balanceFen = position?.balanceFen ?? 0;
  const activeHoldFen = position?.activeHoldFen ?? 0;
  return {
    activeHoldFen,
    availableFen: Math.max(0, balanceFen - activeHoldFen),
    balanceFen,
  };
}

export async function listAdminWalletAccounts() {
  return db
    .select({
      balanceFen: sql<number>`coalesce(${walletAccounts.balanceFen}, 0)`.mapWith(Number),
      customerCode: customers.code,
      customerId: customers.id,
      customerName: customers.name,
      status: customers.status,
      updatedAt: walletAccounts.updatedAt,
    })
    .from(customers)
    .leftJoin(walletAccounts, eq(walletAccounts.customerId, customers.id))
    .orderBy(customers.code);
}

export async function listAdminWalletTransactions(limit = 100) {
  return db
    .select({
      afterBalanceFen: walletTransactions.afterBalanceFen,
      beforeBalanceFen: walletTransactions.beforeBalanceFen,
      createdAt: walletTransactions.createdAt,
      customerCode: customers.code,
      customerName: customers.name,
      deltaFen: walletTransactions.deltaFen,
      id: walletTransactions.id,
      orderNumber: fulfillmentOrders.orderNumber,
      reason: walletTransactions.reason,
      transactionType: walletTransactions.transactionType,
    })
    .from(walletTransactions)
    .innerJoin(customers, eq(customers.id, walletTransactions.customerId))
    .leftJoin(fulfillmentOrders, eq(fulfillmentOrders.id, walletTransactions.orderId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit);
}

export async function getCustomerWalletView(customerId: string) {
  const position = await getWalletPosition(customerId);
  const transactionRows = await db
    .select({
      afterBalanceFen: walletTransactions.afterBalanceFen,
      createdAt: walletTransactions.createdAt,
      deltaFen: walletTransactions.deltaFen,
      id: walletTransactions.id,
      orderNumber: fulfillmentOrders.orderNumber,
      transactionType: walletTransactions.transactionType,
    })
    .from(walletTransactions)
    .leftJoin(fulfillmentOrders, eq(fulfillmentOrders.id, walletTransactions.orderId))
    .where(eq(walletTransactions.customerId, customerId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  const transactions = transactionRows.map((transaction) => ({
    ...transaction,
    reason: publicWalletTransactionReason(transaction.transactionType),
  }));
  const holdRows = await db
    .select({
      amountFen: walletHolds.amountFen,
      batchNumber: settlementBatches.batchNumber,
      createdAt: walletHolds.createdAt,
      id: walletHolds.id,
      releasedAt: walletHolds.releasedAt,
      settlementBatchId: walletHolds.settlementBatchId,
      status: walletHolds.status,
    })
    .from(walletHolds)
    .innerJoin(
      settlementBatches,
      eq(settlementBatches.id, walletHolds.settlementBatchId),
    )
    .where(eq(walletHolds.customerId, customerId))
    .orderBy(desc(walletHolds.createdAt))
    .limit(50);
  const holds = holdRows.map((hold) => ({
    ...hold,
    releaseReason: publicWalletHoldReleaseReason(hold.status),
  }));

  return { ...position, holds, transactions };
}
