import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { customerUsers, customers, stores } from "@/db/schema";

export type CustomerManagementListRow = {
  accountDisplayName: string | null;
  accountStatus: "ACTIVE" | "DISABLED" | null;
  code: string;
  contactName: string | null;
  customerId: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
  storeCount: number;
};

export async function listCustomerManagementRows(): Promise<CustomerManagementListRow[]> {
  const rows = await db.execute<CustomerManagementListRow>(sql`
    select
      c.id as "customerId",
      c.code as "code",
      c.name as "name",
      c.contact_name as "contactName",
      c.status as "status",
      cu.display_name as "accountDisplayName",
      cu.status as "accountStatus",
      coalesce(count(distinct s.id), 0)::int as "storeCount"
    from customers c
    left join customer_users cu
      on cu.customer_id = c.id
    left join stores s
      on s.customer_id = c.id
    group by c.id, cu.id
    order by lower(c.code), lower(c.name)
  `);

  return rows.map((row) => ({
    ...row,
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

  const [account] = await db
    .select()
    .from(customerUsers)
    .where(eq(customerUsers.customerId, customerId))
    .limit(1);
  const customerStores = await db
    .select()
    .from(stores)
    .where(eq(stores.customerId, customerId));

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
    stores: customerStores,
  };
}
