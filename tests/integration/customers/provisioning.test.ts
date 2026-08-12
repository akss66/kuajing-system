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

test("provisions a customer, store and sign-in account together", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `provision-${suffix}@test.tongzhouxing.local`;
  const result = await provisionCustomerWithStore({
    actorId: "integration-test",
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
    actorId: "integration-test",
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
    actor: { kind: "ADMIN", userId: "admin-auth-user" },
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
    actorId: "integration-test",
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
