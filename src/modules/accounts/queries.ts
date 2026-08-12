import { sql } from "drizzle-orm";

import { db } from "@/db/client";

export type ManagedAccountSummary = {
  customerId: string | null;
  customerName: string | null;
  displayName: string;
  email: string;
  kind: "ADMIN" | "CUSTOMER" | "SUPER_ADMIN";
  status: "ACTIVE" | "DISABLED";
  storeCount: number;
  userId: string;
};

export async function listManagedAccounts(): Promise<ManagedAccountSummary[]> {
  const rows = await db.execute<ManagedAccountSummary>(sql`
    select
      u.id as "userId",
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
      coalesce(count(s.id), 0)::int as "storeCount"
    from auth_users u
    left join customers c
      on c.id = u.customer_id
    left join stores s
      on s.customer_id = u.customer_id
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
    storeCount: Number(row.storeCount),
  }));
}
