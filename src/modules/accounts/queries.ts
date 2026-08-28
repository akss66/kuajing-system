import { sql } from "drizzle-orm";

import { db } from "@/db/client";

export type ManagedAccountSummary = {
  aiSkuMatchEnabled: boolean;
  customerId: string | null;
  customerName: string | null;
  displayName: string;
  email: string;
  kind: "ADMIN" | "CUSTOMER" | "SUPER_ADMIN";
  lastLoginAt: Date | null;
  status: "ACTIVE" | "DISABLED";
  storeCount: number;
  userId: string;
};

export async function listManagedAccounts(): Promise<ManagedAccountSummary[]> {
  const rows = await db.execute<ManagedAccountSummary>(sql`
    select
      u.id as "userId",
      coalesce(c.ai_sku_match_enabled, false) as "aiSkuMatchEnabled",
      u.name as "displayName",
      u.email as "email",
      u.customer_id as "customerId",
      c.name as "customerName",
      case
        when u.role = 'super_admin' then 'SUPER_ADMIN'
        when u.role = 'admin' then 'ADMIN'
        else 'CUSTOMER'
      end as "kind",
      case
        when u.banned then 'DISABLED'
        else 'ACTIVE'
      end as "status",
      max(sessions.updated_at) as "lastLoginAt",
      coalesce(count(distinct s.id), 0)::int as "storeCount"
    from auth_users u
    left join customers c
      on c.id = u.customer_id
    left join stores s
      on s.customer_id = u.customer_id
    left join auth_sessions sessions
      on sessions.user_id = u.id
    group by u.id, c.id
    order by
      case
        when u.role = 'super_admin' then 0
        when u.role = 'admin' then 1
        else 2
      end,
      lower(u.email)
  `);

  return rows.map((row) => ({
    ...row,
    lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt) : null,
    storeCount: Number(row.storeCount),
  }));
}
