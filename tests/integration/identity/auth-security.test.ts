import { afterEach, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  customers,
} from "@/db/schema";

async function withAuthModules<T>(
  baseURL: string,
  run: (input: {
    auth: typeof import("@/modules/identity/auth").auth;
    getCurrentPrincipal: typeof import("@/modules/identity/principal").getCurrentPrincipal;
  }) => Promise<T>,
) {
  const originalBaseURL = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = baseURL;
  vi.resetModules();

  try {
    const { auth } = await import("@/modules/identity/auth");
    const { getCurrentPrincipal } = await import("@/modules/identity/principal");
    return await run({ auth, getCurrentPrincipal });
  } finally {
    if (originalBaseURL === undefined) {
      delete process.env.BETTER_AUTH_URL;
    } else {
      process.env.BETTER_AUTH_URL = originalBaseURL;
    }
    vi.resetModules();
  }
}

afterEach(async () => {
  await db.delete(authSessions);
  await db.delete(authAccounts);
  await db.delete(authVerifications);
  await db.delete(authUsers);
  await db.delete(customers);
});

test("public email and password registration is disabled", async () => {
  await withAuthModules("http://127.0.0.1:3000", async ({ auth }) => {
    const response = await auth.handler(
      new Request("http://127.0.0.1:3000/api/auth/sign-up/email", {
        body: JSON.stringify({
          email: "unapproved@example.com",
          name: "Unauthorized registration",
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
});

test.each([
  {
    baseURL: "http://127.0.0.1:3000",
    expectSecure: false,
    requestOrigin: "http://127.0.0.1:3000",
  },
  {
    baseURL: "https://tongzhouxing.example.com",
    expectSecure: true,
    requestOrigin: "https://tongzhouxing.example.com",
  },
])(
  "managed accounts enforce strong passwords and cookie policy for $baseURL",
  async ({ baseURL, expectSecure, requestOrigin }) => {
    await withAuthModules(baseURL, async ({ auth }) => {
      const email = `admin-${crypto.randomUUID()}@tongzhouxing.local`;

      await expect(
        auth.api.createUser({
          body: {
            email,
            name: "Managed Admin",
            password: "too-short",
            role: "admin",
          },
        }),
      ).rejects.toThrow();

      await auth.api.createUser({
        body: {
          email,
          name: "Managed Admin",
          password: "valid-test-password-2026",
          role: "admin",
        },
      });

      const response = await auth.handler(
        new Request(`${requestOrigin}/api/auth/sign-in/email`, {
          body: JSON.stringify({ email, password: "valid-test-password-2026" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      const cookie = response.headers.get("set-cookie") ?? "";

      expect(response.status).toBe(200);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      if (expectSecure) {
        expect(cookie).toContain("Secure");
      } else {
        expect(cookie).not.toContain("Secure");
      }
    });
  },
);

test("a signed-in customer session resolves to its tenant principal", async () => {
  await withAuthModules(
    "http://127.0.0.1:3000",
    async ({ auth, getCurrentPrincipal }) => {
      const [customer] = await db
        .insert(customers)
        .values({
          code: `AUTH-${crypto.randomUUID().slice(0, 12)}`,
          name: "Authenticated customer",
        })
        .returning({ id: customers.id });
      const email = `customer-${crypto.randomUUID()}@tongzhouxing.local`;

      const created = await auth.api.createUser({
        body: {
          data: { customerId: customer.id },
          email,
          name: "Customer Operator",
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
    },
  );
});
