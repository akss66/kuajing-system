import { sql } from "drizzle-orm";
import { expect, test } from "vitest";

import { db } from "@/db/client";

test("report filters have dedicated production indexes", async () => {
  const rows = await db.execute<{ indexname: string }>(sql`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'fulfillment_orders_status_submitted_index',
        'order_shipments_kind_shipped_index',
        'payment_claims_status_reviewed_index',
        'wallet_transactions_created_index'
      )
    order by indexname
  `);

  expect(rows.map((row) => row.indexname)).toEqual([
    "fulfillment_orders_status_submitted_index",
    "order_shipments_kind_shipped_index",
    "payment_claims_status_reviewed_index",
    "wallet_transactions_created_index",
  ]);
});
