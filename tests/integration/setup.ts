import { sql } from "drizzle-orm";
import { beforeAll } from "vitest";

import { db } from "@/db/client";

beforeAll(async () => {
  await db.execute(sql.raw(`
    truncate table
      system_notifications,
      integration_attempts,
      integration_outbox,
      replacement_requests,
      shipment_fulfillments,
      audit_logs,
      payment_claims,
      wallet_transactions,
      wallet_accounts,
      order_lines,
      order_shipments,
      fulfillment_orders,
      order_import_rows,
      order_import_batches,
      inventory_movements,
      inventory_reservations,
      inventory_balances,
      sku_aliases,
      customer_sku_prices,
      auth_sessions,
      auth_accounts,
      auth_verifications,
      auth_users,
      customer_users,
      admin_users,
      stores,
      skus,
      products,
      customers
    restart identity cascade
  `));
});
