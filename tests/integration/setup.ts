import { sql } from "drizzle-orm";
import { beforeAll } from "vitest";

import { db } from "@/db/client";

beforeAll(async () => {
  await db.execute(sql.raw(`
    truncate table
      audit_logs,
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
