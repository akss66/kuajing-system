import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  authAccounts,
  authSessions,
  authUsers,
  customerUsers,
  customers,
  stores,
  walletAccounts,
} from "@/db/schema";
import type {
  AdminPrincipal,
  SuperAdminPrincipal,
} from "@/modules/identity/principal";
import { maskEmail } from "@/shared/privacy";

import { getCustomerManagementDetail as getCustomerManagementDetailQuery } from "./queries";

export type ProvisionCustomerInput = {
  actorId: string;
  code: string;
  customerName: string;
  email: string;
  password: string;
  storeName: string;
};

type CustomerManagerActor = AdminPrincipal | SuperAdminPrincipal;
type ManagedStatus = "ACTIVE" | "DISABLED";

export class CustomerManagementError extends Error {
  constructor(
    public readonly code:
      | "CUSTOMER_NOT_FOUND"
      | "STORE_NOT_FOUND"
      | "INVALID_REASON",
    message: string,
  ) {
    super(message);
    this.name = "CustomerManagementError";
  }
}

function assertReason(reason: string) {
  const value = reason.trim();
  if (!value) {
    throw new CustomerManagementError("INVALID_REASON", "A reason is required");
  }
  return value;
}

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
    await tx.insert(walletAccounts).values({ customerId: customer.id });
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
    await tx.insert(customerUsers).values({
      customerId: customer.id,
      displayName: input.customerName,
      loginIdentifier: input.email.toLowerCase(),
      status: "ACTIVE",
    });
    await tx.insert(auditLogs).values({
      action: "CUSTOMER_CREATED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: {
        customerName: input.customerName,
        email: maskEmail(input.email.toLowerCase()),
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

export async function getCustomerManagementDetail(customerId: string) {
  return getCustomerManagementDetailQuery(customerId);
}

export async function updateCustomer(input: {
  actor: CustomerManagerActor;
  code: string;
  contactName?: string | null;
  contactWechat?: string | null;
  customerId: string;
  name: string;
  reason: string;
}) {
  const reason = assertReason(input.reason);
  await db.transaction(async (tx) => {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!customer) {
      throw new CustomerManagementError("CUSTOMER_NOT_FOUND", "Customer not found");
    }

    await tx
      .update(customers)
      .set({
        code: input.code.trim(),
        contactName: input.contactName?.trim() || null,
        contactWechat: input.contactWechat?.trim() || null,
        name: input.name.trim(),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, input.customerId));

    await tx.insert(auditLogs).values({
      action: "CUSTOMER_UPDATED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        code: input.code.trim(),
        contactName: input.contactName?.trim() || null,
        contactWechat: input.contactWechat?.trim() || null,
        name: input.name.trim(),
      },
      beforeJson: {
        code: customer.code,
        contactName: customer.contactName,
        contactWechat: customer.contactWechat,
        name: customer.name,
      },
      entityId: input.customerId,
      entityType: "CUSTOMER",
      reason,
    });
  });
}

export async function setCustomerStatus(input: {
  actor: CustomerManagerActor;
  customerId: string;
  reason: string;
  status: ManagedStatus;
}) {
  const banned = input.status === "DISABLED";
  const reason = assertReason(input.reason);

  await db.transaction(async (tx) => {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!customer) {
      throw new CustomerManagementError("CUSTOMER_NOT_FOUND", "Customer not found");
    }

    const [authUser] = await tx
      .select()
      .from(authUsers)
      .where(eq(authUsers.customerId, input.customerId))
      .limit(1);

    await tx
      .update(customers)
      .set({
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, input.customerId));
    await tx
      .update(customerUsers)
      .set({
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(customerUsers.customerId, input.customerId));

    if (authUser) {
      await tx
        .update(authUsers)
        .set({
          banned,
          banReason: banned ? reason : null,
          banExpires: null,
          updatedAt: new Date(),
        })
        .where(eq(authUsers.id, authUser.id));
      if (banned) {
        await tx.delete(authSessions).where(eq(authSessions.userId, authUser.id));
      }
    }

    await tx.insert(auditLogs).values({
      action: "CUSTOMER_STATUS_CHANGED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        status: input.status,
      },
      beforeJson: {
        status: customer.status,
      },
      entityId: input.customerId,
      entityType: "CUSTOMER",
      reason,
    });
  });
}

export async function createStore(input: {
  actor: CustomerManagerActor;
  customerId: string;
  externalStoreCode?: string | null;
  name: string;
  platform?: string | null;
  reason: string;
}) {
  const reason = assertReason(input.reason);

  return db.transaction(async (tx) => {
    const [store] = await tx
      .insert(stores)
      .values({
        customerId: input.customerId,
        externalStoreCode: input.externalStoreCode?.trim() || null,
        name: input.name.trim(),
        platform: input.platform?.trim() || "TEMU",
        status: "ACTIVE",
      })
      .returning();

    await tx.insert(auditLogs).values({
      action: "STORE_CREATED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        externalStoreCode: store.externalStoreCode,
        name: store.name,
        platform: store.platform,
        status: store.status,
      },
      beforeJson: {},
      entityId: store.id,
      entityType: "STORE",
      reason,
    });

    return store;
  });
}

export async function updateStore(input: {
  actor: CustomerManagerActor;
  externalStoreCode?: string | null;
  name: string;
  platform?: string | null;
  reason: string;
  storeId: string;
}) {
  const reason = assertReason(input.reason);
  await db.transaction(async (tx) => {
    const [store] = await tx
      .select()
      .from(stores)
      .where(eq(stores.id, input.storeId))
      .limit(1);
    if (!store) {
      throw new CustomerManagementError("STORE_NOT_FOUND", "Store not found");
    }

    await tx
      .update(stores)
      .set({
        externalStoreCode: input.externalStoreCode?.trim() || null,
        name: input.name.trim(),
        platform: input.platform?.trim() || store.platform,
        updatedAt: new Date(),
      })
      .where(eq(stores.id, input.storeId));

    await tx.insert(auditLogs).values({
      action: "STORE_UPDATED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        externalStoreCode: input.externalStoreCode?.trim() || null,
        name: input.name.trim(),
        platform: input.platform?.trim() || store.platform,
      },
      beforeJson: {
        externalStoreCode: store.externalStoreCode,
        name: store.name,
        platform: store.platform,
      },
      entityId: input.storeId,
      entityType: "STORE",
      reason,
    });
  });
}

export async function setStoreStatus(input: {
  actor: CustomerManagerActor;
  reason: string;
  status: ManagedStatus;
  storeId: string;
}) {
  const reason = assertReason(input.reason);
  await db.transaction(async (tx) => {
    const [store] = await tx
      .select()
      .from(stores)
      .where(eq(stores.id, input.storeId))
      .limit(1);
    if (!store) {
      throw new CustomerManagementError("STORE_NOT_FOUND", "Store not found");
    }

    await tx
      .update(stores)
      .set({
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(stores.id, input.storeId));

    await tx.insert(auditLogs).values({
      action: "STORE_STATUS_CHANGED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        status: input.status,
      },
      beforeJson: {
        status: store.status,
      },
      entityId: input.storeId,
      entityType: "STORE",
      reason,
    });
  });
}
