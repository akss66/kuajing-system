import { afterEach, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  customers,
} from "@/db/schema";
import { auth } from "@/modules/identity/auth";
import { getCurrentPrincipal } from "@/modules/identity/principal";

afterEach(async () => {
  await db.delete(authSessions);
  await db.delete(authAccounts);
  await db.delete(authVerifications);
  await db.delete(authUsers);
  await db.delete(customers);
});

test("public email and password registration is disabled", async () => {
  const response = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-up/email", {
      body: JSON.stringify({
        email: "unapproved@example.com",
        name: "未授权注册",
        password: "not-allowed-password",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const body = (await response.json()) as { code?: string };

  expect(response.status).toBe(400);
  expect(body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
});

test("managed accounts enforce strong passwords and secure session cookies", async () => {
  const email = `admin-${crypto.randomUUID()}@tongzhouxing.local`;

  await expect(
    auth.api.createUser({
      body: {
        email,
        name: "超级管理员",
        password: "too-short",
        role: "admin",
      },
    }),
  ).rejects.toThrow();

  await auth.api.createUser({
    body: {
      email,
      name: "超级管理员",
      password: "valid-test-password-2026",
      role: "admin",
    },
  });

  const response = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "valid-test-password-2026" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const cookie = response.headers.get("set-cookie") ?? "";

  expect(response.status).toBe(200);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Secure");
});

test("a signed-in customer session resolves to its tenant principal", async () => {
  const [customer] = await db
    .insert(customers)
    .values({ code: `AUTH-${crypto.randomUUID().slice(0, 12)}`, name: "认证客户" })
    .returning({ id: customers.id });
  const email = `customer-${crypto.randomUUID()}@tongzhouxing.local`;

  const created = await auth.api.createUser({
    body: {
      data: { customerId: customer.id },
      email,
      name: "客户操作员",
      password: "valid-test-password-2026",
      role: "user",
    },
  });
  const response = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "valid-test-password-2026" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const sessionCookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const principal = await getCurrentPrincipal(new Headers({ cookie: sessionCookie }));

  expect(principal).toEqual({
    kind: "CUSTOMER",
    customerId: customer.id,
    userId: created.user.id,
  });
});
