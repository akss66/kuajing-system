import { expect, test } from "vitest";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, walletAccounts } from "@/db/schema";
import { auth } from "@/modules/identity/auth";
import { getCurrentPrincipal } from "@/modules/identity/principal";
import { provisionCustomerWithStore } from "@/modules/customers/service";

test("provisions a customer, store and sign-in account together", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `provision-${suffix}@test.tongzhouxing.local`;
  const result = await provisionCustomerWithStore({
    actorId: "integration-test",
    code: `P-${suffix}`,
    customerName: "Provisioned customer",
    email,
    password: "valid-customer-password-2026",
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
    .select({ afterJson: auditLogs.afterJson })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, result.customerId));
  expect(audit.afterJson).toMatchObject({
    email: `p***@test.tongzhouxing.local`,
  });
  expect(JSON.stringify(audit.afterJson)).not.toContain(email);
});
