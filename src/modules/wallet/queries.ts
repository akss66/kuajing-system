import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";

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
  const [wallet] = await db
    .select({ balanceFen: walletAccounts.balanceFen })
    .from(walletAccounts)
    .where(eq(walletAccounts.customerId, customerId))
    .limit(1);
  const transactions = await db
    .select({
      afterBalanceFen: walletTransactions.afterBalanceFen,
      createdAt: walletTransactions.createdAt,
      deltaFen: walletTransactions.deltaFen,
      id: walletTransactions.id,
      orderNumber: fulfillmentOrders.orderNumber,
      reason: walletTransactions.reason,
      transactionType: walletTransactions.transactionType,
    })
    .from(walletTransactions)
    .leftJoin(fulfillmentOrders, eq(fulfillmentOrders.id, walletTransactions.orderId))
    .where(eq(walletTransactions.customerId, customerId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);

  return { balanceFen: wallet?.balanceFen ?? 0, transactions };
}
