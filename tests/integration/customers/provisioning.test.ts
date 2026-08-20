import { afterEach, expect, test } from "vitest";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  authSessions,
  authUsers,
  customerUsers,
  customers,
  stores,
  walletAccounts,
} from "@/db/schema";
import { auth } from "@/modules/identity/auth";
import { getCurrentPrincipal } from "@/modules/identity/principal";
import {
  getCustomerManagementDetail,
  provisionCustomerWithStore,
  setCustomerStatus,
  updateCustomer,
} from "@/modules/customers/service";

afterEach(async () => {
  await db.delete(authSessions);
  await db.delete(customerUsers);
  await db.delete(authUsers);
  await db.delete(stores);
  await db.delete(walletAccounts);
  await db.delete(auditLogs);
  await db.delete(customers);
});

test("customer account provisioning rejects a non-super-admin service caller", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);

  await expect(
    provisionCustomerWithStore({
      actor: { kind: "ADMIN", userId: "ordinary-admin-auth-user" },
      code: `R-${suffix}`,
      customerName: "Rejected provision customer",
      email: `rejected-${suffix}@test.tongzhouxing.local`,
      password: "valid-customer-password-2026",
      reason: "Attempt account provisioning",
      storeName: "Rejected provision store",
    } as never),
  ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
  expect(await db.select().from(customers)).toEqual([]);
});

test("customer login status rejects a non-super-admin service caller", async () => {
  const [customer] = await db
    .insert(customers)
    .values({ code: `S-${crypto.randomUUID()}`, name: "Protected status customer" })
    .returning({ id: customers.id });

  await expect(
    setCustomerStatus({
      actor: { kind: "ADMIN", userId: "ordinary-admin-auth-user" },
      customerId: customer.id,
      reason: "Attempt account suspension",
      status: "DISABLED",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
  const [persisted] = await db
    .select({ status: customers.status })
    .from(customers)
    .where(eq(customers.id, customer.id));
  expect(persisted.status).toBe("ACTIVE");
});

test("provisions a customer, store and sign-in account together", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `provision-${suffix}@test.tongzhouxing.local`;
  const result = await provisionCustomerWithStore({
    actor: { kind: "SUPER_ADMIN", userId: "integration-test" },
    code: `P-${suffix}`,
    customerName: "Provisioned customer",
    email,
    password: "valid-customer-password-2026",
    reason: "Create initial customer account",
    storeName: "Provisioned TEMU store",
  });

  const response = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "valid-customer-password-2026" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const principal = await getCurrentPrincipal(new Headers({ cookie }));

  expect(response.status).toBe(200);
  expect(principal).toMatchObject({
    customerId: result.customerId,
    kind: "CUSTOMER",
  });
  expect(result.storeId).toMatch(/^[0-9a-f-]{36}$/);
  const [wallet] = await db
    .select()
    .from(walletAccounts)
    .where(eq(walletAccounts.customerId, result.customerId));
  expect(wallet.balanceFen).toBe(0);
  const [audit] = await db
    .select({ afterJson: auditLogs.afterJson, reason: auditLogs.reason })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, result.customerId));
  expect(audit.afterJson).toMatchObject({
    email: `p***@test.tongzhouxing.local`,
  });
  expect(audit.reason).toBe("Create initial customer account");
  expect(JSON.stringify(audit.afterJson)).not.toContain(email);
  const [customerUser] = await db
    .select()
    .from(customerUsers)
    .where(eq(customerUsers.customerId, result.customerId));
  expect(customerUser.loginIdentifier).toBe(email.toLowerCase());
  expect(customerUser.status).toBe("ACTIVE");
});

test("disabling a customer also disables the linked auth account and revokes sessions", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `disable-${suffix}@test.tongzhouxing.local`;
  const result = await provisionCustomerWithStore({
    actor: { kind: "SUPER_ADMIN", userId: "integration-test" },
    code: `D-${suffix}`,
    customerName: "Disable customer",
    email,
    password: "valid-customer-password-2026",
    reason: "Create account before disable flow",
    storeName: "Disable store",
  });

  const signInResponse = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "valid-customer-password-2026" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  expect(signInResponse.status).toBe(200);
  expect(await db.select().from(authSessions)).toHaveLength(1);

  await setCustomerStatus({
    actor: { kind: "SUPER_ADMIN", userId: "admin-auth-user" },
    customerId: result.customerId,
    reason: "Compliance hold",
    status: "DISABLED",
  });

  const [authUser] = await db
    .select()
    .from(authUsers)
    .where(eq(authUsers.id, result.userId));
  expect(authUser.banned).toBe(true);
  expect(await db.select().from(authSessions)).toEqual([]);
});

test("customer management detail returns the linked account summary and store count", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `detail-${suffix}@test.tongzhouxing.local`;
  const result = await provisionCustomerWithStore({
    actor: { kind: "SUPER_ADMIN", userId: "integration-test" },
    code: `G-${suffix}`,
    customerName: "Detail customer",
    email,
    password: "valid-customer-password-2026",
    reason: "Create account before detail lookup",
    storeName: "Detail store",
  });

  const detail = await getCustomerManagementDetail(result.customerId);
  expect(detail).toMatchObject({
    account: {
      email: email.toLowerCase(),
      status: "ACTIVE",
    },
    customer: {
      id: result.customerId,
    },
  });
  expect(detail.stores).toHaveLength(1);
});

test("customer profile audit masks contact PII instead of duplicating plaintext", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const result = await provisionCustomerWithStore({
    actor: { kind: "SUPER_ADMIN", userId: "integration-test" },
    code: `A-${suffix}`,
    customerName: "Audit privacy customer",
    email: `audit-${suffix}@test.tongzhouxing.local`,
    password: "valid-customer-password-2026",
    reason: "Create customer before privacy audit",
    storeName: "Audit privacy store",
  });

  await updateCustomer({
    actor: { kind: "ADMIN", userId: "admin-auth-user" },
    code: `A-${suffix}`,
    contactName: "李青华",
    contactWechat: "liqing-private-wechat",
    customerId: result.customerId,
    name: "Audit privacy customer",
    reason: "Update operational contact",
  });

  const [audit] = await db
    .select({ afterJson: auditLogs.afterJson, beforeJson: auditLogs.beforeJson })
    .from(auditLogs)
    .where(eq(auditLogs.action, "CUSTOMER_UPDATED"));

  expect(audit.afterJson).toMatchObject({
    contactName: "李**",
    contactWechat: "li***",
  });
  expect(JSON.stringify(audit)).not.toContain("李青华");
  expect(JSON.stringify(audit)).not.toContain("liqing-private-wechat");
});
