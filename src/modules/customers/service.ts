import { hashPassword } from "better-auth/crypto";

import { db } from "@/db/client";
import {
  auditLogs,
  authAccounts,
  authUsers,
  customers,
  stores,
} from "@/db/schema";

export type ProvisionCustomerInput = {
  actorId: string;
  code: string;
  customerName: string;
  email: string;
  password: string;
  storeName: string;
};

export async function provisionCustomerWithStore(
  input: ProvisionCustomerInput,
): Promise<{ customerId: string; storeId: string; userId: string }> {
  const passwordHash = await hashPassword(input.password);
  const userId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ code: input.code, name: input.customerName })
      .returning({ id: customers.id });
    const [store] = await tx
      .insert(stores)
      .values({ customerId: customer.id, name: input.storeName })
      .returning({ id: stores.id });
    await tx.insert(authUsers).values({
      customerId: customer.id,
      email: input.email.toLowerCase(),
      id: userId,
      name: input.customerName,
      role: "user",
    });
    await tx.insert(authAccounts).values({
      accountId: userId,
      id: crypto.randomUUID(),
      password: passwordHash,
      providerId: "credential",
      userId,
    });
    await tx.insert(auditLogs).values({
      action: "CUSTOMER_CREATED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: {
        customerName: input.customerName,
        email: input.email.toLowerCase(),
        storeId: store.id,
        storeName: input.storeName,
      },
      beforeJson: {},
      entityId: customer.id,
      entityType: "CUSTOMER",
      reason: "管理员创建合作客户、店铺与登录账号",
    });

    return { customerId: customer.id, storeId: store.id, userId };
  });
}
