import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  authSessions,
  authUsers,
  customerUsers,
  customers,
  stores,
} from "@/db/schema";
import { seed } from "@/db/seed";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
  userId: "00000000-0000-4000-8000-00000000a001",
};

async function openAdminNavigationIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await page.getByRole("button", { name: "打开导航" }).click();
  }
}

function accountUpdateForm(userId: string, page: Page) {
  return page.locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="displayName"])`).first();
}

function accountResetPasswordForm(userId: string, page: Page) {
  return page.locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="newPassword"])`).first();
}

function accountStatusForm(userId: string, page: Page) {
  return page.locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="status"])`).first();
}

function customerProfileForm(customerId: string, page: Page) {
  return page.locator(`form:has(input[name="customerId"][value="${customerId}"]):has(input[name="code"])`).first();
}

function addStoreForm(customerId: string, page: Page) {
  return page.locator(`form:has(input[name="customerId"][value="${customerId}"]):has(input[name="platform"]):not(:has(input[name="storeId"]))`).first();
}

async function confirmDialog(scope: Locator, page: Page, buttonName: string) {
  await scope.getByRole("button", { name: buttonName }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: buttonName }).click();
}

function loginErrorMessage(page: Page) {
  return page.locator("p[role='alert']").filter({ hasText: "邮箱或密码不正确" });
}

test("super admin can govern admin accounts and ordinary admins are denied account governance", async ({
  page,
}) => {
  await seed();
  const suffix = crypto.randomUUID().slice(0, 8);
  const createdEmail = `ops-${suffix}@e2e.tongzhouxing.local`;
  const updatedEmail = `ops-${suffix}-updated@e2e.tongzhouxing.local`;
  const initialPassword = `Initial-${suffix}-Password!`;
  const resetPassword = `Reset-${suffix}-Password!`;

  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);

  await openAdminNavigationIfNeeded(page);
  await expect(page.getByRole("link", { name: "账号管理" })).toBeVisible();
  await page.getByRole("link", { name: "账号管理" }).click();

  await expect(page).toHaveURL(/\/admin\/accounts$/);
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();
  await expect(page.getByText("只允许创建普通管理员")).toBeVisible();
  await expect(
    page.locator(
      `form:has(input[name="userId"][value="${seededSuperAdmin.userId}"]):has(input[name="newPassword"])`,
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      `form:has(input[name="userId"][value="${seededSuperAdmin.userId}"]):has(input[name="status"])`,
    ),
  ).toHaveCount(0);

  await page.getByLabel("管理员姓名").fill("E2E 值班管理员");
  await page.getByLabel("登录邮箱").fill(createdEmail);
  await page.getByLabel("初始密码").fill(initialPassword);
  await page.getByLabel("创建原因").fill("E2E 创建普通管理员");
  await page.getByRole("button", { name: "创建管理员账号" }).click();
  await expect(page.getByText("普通管理员账号已创建。")).toBeVisible();

  await expect.poll(async () => {
    const [user] = await db
      .select({
        banned: authUsers.banned,
        email: authUsers.email,
        id: authUsers.id,
        name: authUsers.name,
        role: authUsers.role,
      })
      .from(authUsers)
      .where(eq(authUsers.email, createdEmail));
    return user ?? null;
  }).toMatchObject({
    banned: false,
    email: createdEmail,
    name: "E2E 值班管理员",
    role: "admin",
  });

  const createdUserId = (
    await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, createdEmail))
  )[0]!.id;

  await expect.poll(async () => {
    const [mirror] = await db
      .select({
        displayName: adminUsers.displayName,
        loginIdentifier: adminUsers.loginIdentifier,
        status: adminUsers.status,
      })
      .from(adminUsers)
      .where(eq(adminUsers.loginIdentifier, createdEmail));
    return mirror ?? null;
  }).toMatchObject({
    displayName: "E2E 值班管理员",
    loginIdentifier: createdEmail,
    status: "ACTIVE",
  });

  const updateForm = accountUpdateForm(createdUserId, page);
  await updateForm.getByLabel("姓名").fill("E2E 运营管理员");
  await updateForm.getByLabel("账号邮箱").fill(updatedEmail);
  await updateForm.getByLabel("修改原因").fill("E2E 修改管理员资料");
  await updateForm.getByRole("button", { name: "保存资料" }).click();
  await expect(page.getByText("账号资料已更新。")).toBeVisible();

  await expect.poll(async () => {
    const [user] = await db
      .select({
        email: authUsers.email,
        name: authUsers.name,
      })
      .from(authUsers)
      .where(eq(authUsers.id, createdUserId));
    return user;
  }).toMatchObject({
    email: updatedEmail,
    name: "E2E 运营管理员",
  });

  const resetForm = accountResetPasswordForm(createdUserId, page);
  await resetForm.getByLabel("新密码").fill(resetPassword);
  await resetForm.getByLabel("重置原因").fill("E2E 重置密码");
  await resetForm.getByRole("button", { name: "重置密码" }).click();
  await expect(page.getByText("登录密码已重置。")).toBeVisible();

  await page.getByRole("button", { name: "退出系统" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, { email: updatedEmail, password: initialPassword });
  await expect(loginErrorMessage(page)).toContainText("邮箱或密码不正确");

  await loginThroughUi(page, { email: updatedEmail, password: resetPassword });
  await expect(page).toHaveURL(/\/admin$/);

  await openAdminNavigationIfNeeded(page);
  await expect(page.getByRole("link", { name: "账号管理" })).toHaveCount(0);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/admin\/accounts$/);
  await expect(page.getByRole("heading", { name: "账号管理受限" })).toBeVisible();

  await page.getByRole("button", { name: "退出系统" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();

  const disableForm = accountStatusForm(createdUserId, page);
  await disableForm.getByLabel("操作原因").fill("E2E 停用管理员");
  await confirmDialog(disableForm, page, "停用账号");
  await expect(page.getByText("账号已停用。")).toBeVisible();

  await expect.poll(async () => {
    const [user] = await db
      .select({ banned: authUsers.banned })
      .from(authUsers)
      .where(eq(authUsers.id, createdUserId));
    return user?.banned;
  }).toBe(true);
  await expect.poll(async () => {
    const sessions = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, createdUserId));
    return sessions.length;
  }).toBe(0);

  await page.getByRole("button", { name: "退出系统" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, { email: updatedEmail, password: resetPassword });
  await expect(loginErrorMessage(page)).toContainText("邮箱或密码不正确");

  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();

  const restoreForm = accountStatusForm(createdUserId, page);
  await restoreForm.getByLabel("操作原因").fill("E2E 恢复管理员");
  await confirmDialog(restoreForm, page, "恢复账号");
  await expect(page.getByText("账号已恢复。")).toBeVisible();

  await expect.poll(async () => {
    const [user] = await db
      .select({ banned: authUsers.banned })
      .from(authUsers)
      .where(eq(authUsers.id, createdUserId));
    return user?.banned;
  }).toBe(false);

  await page.getByRole("button", { name: "退出系统" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, { email: updatedEmail, password: resetPassword });
  await expect(page).toHaveURL(/\/admin$/);
});

test("ordinary admins can manage customer details and multi-store operations", async ({
  page,
}) => {
  const admin = await createManagedUser({ role: "admin" });
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const customerCode = `E2E-${suffix}`;
  const customerEmail = `customer-${suffix.toLowerCase()}@e2e.tongzhouxing.local`;
  const customerPassword = `Customer-${suffix}-Password!`;
  const firstStoreName = `TEMU 多店客户 ${suffix}`;
  const secondStoreName = `TEMU 加拿大二店 ${suffix}`;
  const secondStoreUpdatedName = `${secondStoreName} 更新版`;

  await loginThroughUi(page, admin);
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto("/admin/customers");
  await expect(page.getByRole("heading", { name: "客户与店铺" })).toBeVisible();
  await page.getByLabel("客户编号").fill(customerCode);
  await page.getByLabel("客户名称").fill(`多店客户 ${suffix}`);
  await page.getByLabel("店铺名称").fill(firstStoreName);
  await page.getByLabel("登录邮箱").fill(customerEmail);
  await page.getByLabel("初始密码").fill(customerPassword);
  await page.getByLabel("创建原因").fill("E2E 创建客户和首店");
  await page.getByRole("button", { name: "创建客户与店铺" }).click();
  await expect(page.getByText("客户与首家店铺已创建。")).toBeVisible();

  await expect.poll(async () => {
    const [customer] = await db
      .select({
        code: customers.code,
        id: customers.id,
        name: customers.name,
        status: customers.status,
      })
      .from(customers)
      .where(eq(customers.code, customerCode));
    return customer ?? null;
  }).toMatchObject({
    code: customerCode,
    name: `多店客户 ${suffix}`,
    status: "ACTIVE",
  });

  const customerId = (
    await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.code, customerCode))
  )[0]!.id;

  await expect.poll(async () => {
    const [user] = await db
      .select({
        banned: authUsers.banned,
        customerId: authUsers.customerId,
        email: authUsers.email,
      })
      .from(authUsers)
      .where(eq(authUsers.email, customerEmail));
    return user ?? null;
  }).toMatchObject({
    banned: false,
    customerId,
    email: customerEmail,
  });

  const row = page.getByRole("row", { name: new RegExp(customerCode) });
  await expect(row.getByText("账号正常")).toBeVisible();
  await expect(row.getByText("1 家店铺")).toBeVisible();
  await row.getByRole("link", { name: "查看详情" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/customers/${customerId}$`));
  await expect(page.getByRole("heading", { name: "客户详情" })).toBeVisible();
  await expect(page.locator(`input[value="${customerEmail}"]`)).toBeVisible();

  const customerForm = customerProfileForm(customerId, page);
  await customerForm.getByLabel("客户名称").fill(`多店客户 ${suffix} 更新`);
  await customerForm.getByLabel("联系人").fill("李青");
  await customerForm.getByLabel("微信").fill(`wechat-${suffix.toLowerCase()}`);
  await customerForm.getByLabel("修改原因").fill("E2E 更新客户资料");
  await customerForm.getByRole("button", { name: "保存客户资料" }).click();
  await expect(page.getByText("客户资料已更新。")).toBeVisible();

  await expect.poll(async () => {
    const [customer] = await db
      .select({
        contactName: customers.contactName,
        contactWechat: customers.contactWechat,
        name: customers.name,
      })
      .from(customers)
      .where(eq(customers.id, customerId));
    return customer;
  }).toMatchObject({
    contactName: "李青",
    contactWechat: `wechat-${suffix.toLowerCase()}`,
    name: `多店客户 ${suffix} 更新`,
  });

  const createStoreForm = addStoreForm(customerId, page);
  await createStoreForm.getByLabel("店铺名称").fill(secondStoreName);
  await createStoreForm.getByLabel("平台").fill("TEMU");
  await createStoreForm.getByLabel("外部店铺编号").fill(`TEMU-${suffix}-002`);
  await createStoreForm.getByLabel("创建原因").fill("E2E 新增第二家店铺");
  await createStoreForm.getByRole("button", { name: "新增店铺" }).click();
  await expect(page.getByText("店铺已新增。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.name, secondStoreName));
    return store?.id ?? null;
  }).not.toBeNull();
  const secondStoreId = (
    await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.name, secondStoreName))
  )[0]!.id;

  await expect.poll(async () => {
    const customerStores = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.customerId, customerId));
    return customerStores.length;
  }).toBe(2);

  const updateStoreForm = page
    .locator(`form:has(input[name="storeId"][value="${secondStoreId}"]):has(input[name="name"])`)
    .first();
  await updateStoreForm.getByLabel("店铺名称").fill(secondStoreUpdatedName);
  await updateStoreForm.getByLabel("平台").fill("TEMU");
  await updateStoreForm.getByLabel("外部店铺编号").fill(`TEMU-${suffix}-002-UPDATED`);
  await updateStoreForm.getByLabel("修改原因").fill("E2E 更新第二家店铺");
  await updateStoreForm.getByRole("button", { name: "保存店铺资料" }).click();
  await expect(page.getByText("店铺资料已更新。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db
      .select({
        externalStoreCode: stores.externalStoreCode,
        name: stores.name,
      })
      .from(stores)
      .where(eq(stores.id, secondStoreId as string));
    return store;
  }).toMatchObject({
    externalStoreCode: `TEMU-${suffix}-002-UPDATED`,
    name: secondStoreUpdatedName,
  });

  const disableStoreForm = page
    .locator(`form:has(input[name="storeId"][value="${secondStoreId}"]):has(input[name="status"][value="DISABLED"])`)
    .first();
  await disableStoreForm.getByLabel("操作原因").fill("E2E 停用第二家店铺");
  await confirmDialog(disableStoreForm, page, "停用店铺");
  await expect(page.getByText("店铺已停用。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, secondStoreId));
    return store?.status;
  }).toBe("DISABLED");

  const restoreStoreForm = page
    .locator(`form:has(input[name="storeId"][value="${secondStoreId}"]):has(input[name="status"][value="ACTIVE"])`)
    .first();
  await restoreStoreForm.getByLabel("操作原因").fill("E2E 恢复第二家店铺");
  await confirmDialog(restoreStoreForm, page, "恢复店铺");
  await expect(page.getByText("店铺已恢复。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db
      .select({ status: stores.status })
      .from(stores)
      .where(eq(stores.id, secondStoreId));
    return store?.status;
  }).toBe("ACTIVE");

  await page.getByRole("button", { name: "退出系统" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin/customers");
  await expect(page).toHaveURL(/\/login$/);

  await expect.poll(async () => {
    const [mirror] = await db
      .select({
        loginIdentifier: customerUsers.loginIdentifier,
        status: customerUsers.status,
      })
      .from(customerUsers)
      .where(eq(customerUsers.customerId, customerId));
    return mirror ?? null;
  }).toMatchObject({
    loginIdentifier: customerEmail,
    status: "ACTIVE",
  });
});
