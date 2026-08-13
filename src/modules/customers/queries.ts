import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customerUsers,
  customers,
  fulfillmentOrders,
  stores,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";

export type CustomerManagementListRow = {
  accountDisplayName: string | null;
  accountEmail: string | null;
  accountStatus: "ACTIVE" | "DISABLED" | null;
  balanceFen: number;
  code: string;
  contactName: string | null;
  customerId: string;
  exceptionOrderCount: number;
  name: string;
  pendingPaymentFen: number;
  recentOrderCount: number;
  status: "ACTIVE" | "DISABLED";
  storeCount: number;
};

export async function listCustomerManagementRows(): Promise<CustomerManagementListRow[]> {
  const rows = await db.execute<CustomerManagementListRow>(sql`
    with account_summary as (
      select distinct on (customer_id)
        customer_id,
        display_name,
        login_identifier,
        status
      from customer_users
      order by customer_id, created_at desc, id desc
    ),
    store_summary as (
      select
        customer_id,
        count(*)::int as store_count
      from stores
      group by customer_id
    ),
    order_summary as (
      select
        customer_id,
        coalesce(
          sum(total_amount_fen) filter (where status = 'PENDING_PAYMENT'),
          0
        )::int as pending_payment_fen,
        count(*) filter (
          where submitted_at >= now() - interval '30 days'
        )::int as recent_order_count,
        count(*) filter (
          where status = 'FULFILLMENT_EXCEPTION'
        )::int as exception_order_count
      from fulfillment_orders
      group by customer_id
    )
    select
      c.id as "customerId",
      c.code as "code",
      c.name as "name",
      c.contact_name as "contactName",
      c.status as "status",
      a.display_name as "accountDisplayName",
      a.login_identifier as "accountEmail",
      a.status as "accountStatus",
      coalesce(s.store_count, 0)::int as "storeCount",
      coalesce(w.balance_fen, 0)::int as "balanceFen",
      coalesce(o.pending_payment_fen, 0)::int as "pendingPaymentFen",
      coalesce(o.recent_order_count, 0)::int as "recentOrderCount",
      coalesce(o.exception_order_count, 0)::int as "exceptionOrderCount"
    from customers c
    left join account_summary a
      on a.customer_id = c.id
    left join store_summary s
      on s.customer_id = c.id
    left join wallet_accounts w
      on w.customer_id = c.id
    left join order_summary o
      on o.customer_id = c.id
    order by lower(c.code), lower(c.name)
  `);

  return rows.map((row) => ({
    ...row,
    balanceFen: Number(row.balanceFen),
    exceptionOrderCount: Number(row.exceptionOrderCount),
    pendingPaymentFen: Number(row.pendingPaymentFen),
    recentOrderCount: Number(row.recentOrderCount),
    storeCount: Number(row.storeCount),
  }));
}

export async function getCustomerManagementDetail(customerId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) {
    throw new Error("CUSTOMER_NOT_FOUND");
  }

  const [
    [account],
    customerStores,
    [wallet],
    [storeSummary],
    [orderSummary],
    recentOrders,
    recentTransactions,
  ] = await Promise.all([
    db
      .select()
      .from(customerUsers)
      .where(eq(customerUsers.customerId, customerId))
      .orderBy(desc(customerUsers.createdAt), desc(customerUsers.id))
      .limit(1),
    db
      .select()
      .from(stores)
      .where(eq(stores.customerId, customerId))
      .orderBy(stores.name, stores.id),
    db
      .select({ balanceFen: walletAccounts.balanceFen })
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customerId))
      .limit(1),
    db
      .select({
        storeCount: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(stores)
      .where(eq(stores.customerId, customerId)),
    db
      .select({
        pendingPaymentFen:
          sql<number>`coalesce(sum(${fulfillmentOrders.totalAmountFen}) filter (where ${fulfillmentOrders.status} = 'PENDING_PAYMENT'), 0)::int`.mapWith(
            Number,
          ),
        recentOrderCount:
          sql<number>`count(*) filter (where ${fulfillmentOrders.submittedAt} >= now() - interval '30 days')::int`.mapWith(
            Number,
          ),
      })
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.customerId, customerId)),
    db
      .select({
        id: fulfillmentOrders.id,
        orderNumber: fulfillmentOrders.orderNumber,
        status: fulfillmentOrders.status,
        storeName: stores.name,
        submittedAt: fulfillmentOrders.submittedAt,
        totalAmountFen: fulfillmentOrders.totalAmountFen,
      })
      .from(fulfillmentOrders)
      .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
      .where(eq(fulfillmentOrders.customerId, customerId))
      .orderBy(desc(fulfillmentOrders.submittedAt), desc(fulfillmentOrders.id))
      .limit(20),
    db
      .select({
        afterBalanceFen: walletTransactions.afterBalanceFen,
        createdAt: walletTransactions.createdAt,
        deltaFen: walletTransactions.deltaFen,
        id: walletTransactions.id,
        reason: walletTransactions.reason,
        transactionType: walletTransactions.transactionType,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.customerId, customerId))
      .orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.id))
      .limit(20),
  ]);

  return {
    account:
      account === undefined
        ? null
        : {
            displayName: account.displayName,
            email: account.loginIdentifier,
            status: account.status,
          },
    customer,
    recentOrders,
    recentTransactions,
    stores: customerStores,
    summary: {
      balanceFen: wallet?.balanceFen ?? 0,
      pendingPaymentFen: orderSummary?.pendingPaymentFen ?? 0,
      recentOrderCount: orderSummary?.recentOrderCount ?? 0,
      storeCount: storeSummary?.storeCount ?? 0,
    },
  };
}
