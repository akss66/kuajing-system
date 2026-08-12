import { sql } from "drizzle-orm";

import { db } from "@/db/client";

type CountRow = { value: number | string };

function count(rows: CountRow[]) {
  return Number(rows[0]?.value ?? 0);
}

export async function getOperationalHealth(input?: { now?: Date }) {
  const now = input?.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 10 * 60_000);
  const [failed, stale, overReserved, walletMismatch, missingTracking] =
    await Promise.all([
      db.execute<CountRow>(sql`
        select count(*) as value
        from integration_outbox
        where status = 'FAILED'
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from integration_outbox
        where status = 'PROCESSING'
          and locked_at < ${staleBefore.toISOString()}::timestamptz
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from (
          select ib.sku_id
          from inventory_balances ib
          join inventory_reservations ir
            on ir.sku_id = ib.sku_id and ir.status = 'ACTIVE'
          group by ib.sku_id, ib.total_quantity
          having sum(ir.quantity) > ib.total_quantity
        ) inconsistent_inventory
      `),
      db.execute<CountRow>(sql`
        with latest as (
          select distinct on (customer_id)
            customer_id,
            after_balance_fen
          from wallet_transactions
          order by customer_id, created_at desc, id desc
        )
        select count(*) as value
        from wallet_accounts wa
        left join latest on latest.customer_id = wa.customer_id
        where wa.balance_fen <> coalesce(latest.after_balance_fen, 0)
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from order_shipments
        where shipped_at is not null
          and nullif(trim(tracking_number), '') is null
      `),
    ]);
  const checks = {
    failedIntegrations: count(failed),
    overReservedSkus: count(overReserved),
    shippedWithoutTracking: count(missingTracking),
    staleProcessingIntegrations: count(stale),
    walletMismatches: count(walletMismatch),
  };
  return {
    checkedAt: now.toISOString(),
    checks,
    status: Object.values(checks).some((value) => value > 0)
      ? ("DEGRADED" as const)
      : ("HEALTHY" as const),
  };
}

export async function checkDatabaseHealth() {
  await db.execute(sql`select 1`);
}
