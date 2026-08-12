import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { customerUsers, customers, stores } from "@/db/schema";

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
