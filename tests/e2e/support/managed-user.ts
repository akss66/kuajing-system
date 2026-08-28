import type { Page } from "@playwright/test";

const password = "valid-e2e-password-2026";

export async function createManagedUser(input: {
  customerId?: string;
  role: "admin" | "super_admin" | "user";
}) {
  const { auth } = await import("@/modules/identity/auth");
  const email = `${input.role}-${crypto.randomUUID()}@e2e.tongzhouxing.local`;
  const created = await auth.api.createUser({
    body: {
      data: input.customerId ? { customerId: input.customerId } : undefined,
      email,
      name:
        input.role === "super_admin"
          ? "E2E super administrator"
          : input.role === "admin"
            ? "E2E administrator"
            : "E2E customer",
      password,
      role: input.role,
    },
  });

  return { email, password, userId: created.user.id };
}

export async function loginThroughUi(
  page: Page,
  credentials: { email: string; password: string },
) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(credentials.email);
  await page.getByLabel("登录密码").fill(credentials.password);
  const authentication = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/auth/sign-in/email",
    { timeout: 30_000 },
  );
  await Promise.all([
    authentication,
    page.getByRole("button", { name: "登录系统" }).click(),
  ]);
}
