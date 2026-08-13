import AxeBuilder from "@axe-core/playwright";
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
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
  userId: "00000000-0000-4000-8000-00000000a001",
};

async function resetAdminManagementBaseline() {
  await resetE2EDatabaseToSeedState({
    context: "admin-management E2E reset",
    database: db,
    reseed: seed,
  });
}

async function openAdminNavigationIfNeeded(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await page.getByRole("button", { name: "打开导航" }).click();
  }

  const systemSection = page.getByRole("button", { name: "系统管理" });
  if ((await systemSection.getAttribute("aria-expanded")) === "false") {
    await systemSection.click();
  }
}

async function signOutThroughShell(page: Page) {
  await page.getByRole("button", { name: "打开账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
}

function accountCreationForm(scope: Locator) {
  return scope
    .locator('form:has(input[name="displayName"]):has(input[name="password"]):not(:has(input[name="userId"]))')
    .first();
}

function accountUpdateForm(userId: string, scope: Locator) {
  return scope
    .locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="displayName"])`)
    .first();
}

function accountResetPasswordForm(userId: string, scope: Locator) {
  return scope
    .locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="newPassword"])`)
    .first();
}

function accountStatusForm(userId: string, scope: Locator) {
  return scope
    .locator(`form:visible:has(input[name="userId"][value="${userId}"]):has(input[name="status"])`)
    .first();
}

async function openAccountDrawer(page: Page, displayName: string) {
  await page.getByRole("button", { name: `查看 ${displayName}` }).click();
  await expect(page.getByRole("dialog", { name: displayName })).toBeVisible();
  return page.getByRole("dialog");
}

async function closeAccountDrawer(dialog: Locator) {
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);
}

function customerProfileForm(customerId: string, scope: Locator) {
  return scope
    .locator(`form:has(input[name="customerId"][value="${customerId}"]):has(input[name="code"])`)
    .first();
}

function customerStatusForm(
  customerId: string,
  nextStatus: "ACTIVE" | "DISABLED",
  scope: Locator,
) {
  return scope
    .locator(
      `form:has(input[name="customerId"][value="${customerId}"]):has(input[name="status"][value="${nextStatus}"]):not(:has(input[name="storeId"]))`,
    )
    .first();
}

function addStoreForm(customerId: string, scope: Locator) {
  return scope
    .locator(
      `form:has(input[name="customerId"][value="${customerId}"]):has(input[name="platform"]):not(:has(input[name="storeId"]))`,
    )
    .first();
}

function storeUpdateForm(storeId: string, scope: Locator) {
  return scope
    .locator(`form:has(input[name="storeId"][value="${storeId}"]):has(input[name="name"])`)
    .first();
}

function storeStatusForm(
  storeId: string,
  nextStatus: "ACTIVE" | "DISABLED",
  scope: Locator,
) {
  return scope
    .locator(
      `form:has(input[name="storeId"][value="${storeId}"]):has(input[name="status"][value="${nextStatus}"])`,
    )
    .first();
}

async function openCustomerEditDrawer(page: Page) {
  await page.getByRole("button", { name: "编辑客户" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑客户" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openStoreDrawer(page: Page, storeName: string) {
  await page.getByRole("button", { name: `管理店铺 ${storeName}` }).click();
  const dialog = page.getByRole("dialog", { name: `管理店铺 · ${storeName}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmDialog(scope: Locator, page: Page, buttonName: string) {
  const trigger = scope.getByRole("button", { name: buttonName });
  const dialog = page.getByRole("alertdialog");

  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: buttonName }).click();
}

function loginErrorMessage(page: Page) {
  return page.locator("p[role='alert']").filter({ hasText: "邮箱或密码不正确" });
}

test("super admin can govern admin accounts and ordinary admins are denied account governance", async ({
  page,
}) => {
  await resetAdminManagementBaseline();
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
  await expect(page.getByRole("button", { name: "新建管理员" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /管理员账号 \d+/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /客户账号 \d+/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /已停用 \d+/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索账号" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "角色筛选" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "状态筛选" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存资料" })).toHaveCount(0);
  await expect(page.locator('form:has(input[name="userId"])')).toHaveCount(0);
  await expect(page.locator('form:has(input[name="password"])')).toHaveCount(0);
  await expect(page.locator('input[name="role"],select[name="role"]')).toHaveCount(0);

  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await expect(page.locator("[data-account-card]").first()).toBeVisible();
    await expect(page.locator("[data-account-table]")).not.toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(1);
  } else {
    await expect(page.locator("[data-account-table]")).toBeVisible();
  }

  const protectedDrawer = await openAccountDrawer(page, "本地演示管理员");
  await expect(protectedDrawer.getByText("受保护")).toBeVisible();
  await expect(protectedDrawer.locator('input[name="newPassword"]')).toHaveCount(0);
  await expect(protectedDrawer.locator('input[name="status"]')).toHaveCount(0);
  await closeAccountDrawer(protectedDrawer);

  await page.getByRole("tab", { name: /客户账号 \d+/ }).click();
  const customerDrawer = await openAccountDrawer(page, "渥太华演示客户");
  await expect(customerDrawer.getByText("1 家店铺")).toBeVisible();
  await expect(customerDrawer.getByRole("link", { name: "查看客户详情" })).toBeVisible();
  await closeAccountDrawer(customerDrawer);
  await page.getByRole("tab", { name: /管理员账号 \d+/ }).click();

  await page.getByRole("button", { name: "新建管理员" }).click();
  const createDrawer = page.getByRole("dialog", { name: "新建管理员" });
  await expect(createDrawer).toBeVisible();
  await expect(
    createDrawer.getByText("只允许创建普通管理员，不提供创建或晋升超级管理员的入口。"),
  ).toBeVisible();
  const createForm = accountCreationForm(createDrawer);
  await createForm.locator('input[name="displayName"]').fill("E2E 值班管理员");
  await createForm.locator('input[name="email"]').fill(createdEmail);
  await createForm.locator('input[name="password"]').fill(initialPassword);
  await createForm.locator('input[name="reason"]').fill("E2E 创建普通管理员");
  await createForm.getByRole("button", { name: "创建管理员账号" }).click();
  await expect(page.getByText("普通管理员账号已创建。")).toBeVisible();
  await closeAccountDrawer(createDrawer);

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
    await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, createdEmail))
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

  const accountDrawer = await openAccountDrawer(page, "E2E 值班管理员");
  const updateForm = accountUpdateForm(createdUserId, accountDrawer);
  await updateForm.locator('input[name="displayName"]').fill("E2E 运营管理员");
  await updateForm.locator('input[name="email"]').fill(updatedEmail);
  await updateForm.locator('input[name="reason"]').fill("E2E 修改管理员资料");
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

  const resetForm = accountResetPasswordForm(createdUserId, accountDrawer);
  await resetForm.locator('input[name="newPassword"]').fill(resetPassword);
  await resetForm.locator('input[name="reason"]').fill("E2E 重置密码");
  await confirmDialog(resetForm, page, "重置密码");
  await expect(page.getByText("登录密码已重置。")).toBeVisible();
  await closeAccountDrawer(accountDrawer);

  await signOutThroughShell(page);
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

  await signOutThroughShell(page);
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();

  const disableDrawer = await openAccountDrawer(page, "E2E 运营管理员");
  const disableForm = accountStatusForm(createdUserId, disableDrawer);
  await disableForm.locator('input[name="reason"]').fill("E2E 停用管理员");
  await confirmDialog(disableForm, page, "停用账号");
  await expect(page.getByText("账号已停用。")).toBeVisible();
  await closeAccountDrawer(disableDrawer);

  await expect.poll(async () => {
    const [user] = await db.select({ banned: authUsers.banned }).from(authUsers).where(eq(authUsers.id, createdUserId));
    return user?.banned;
  }).toBe(true);
  await expect.poll(async () => {
    const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, createdUserId));
    return sessions.length;
  }).toBe(0);

  await signOutThroughShell(page);
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, { email: updatedEmail, password: resetPassword });
  await expect(loginErrorMessage(page)).toContainText("邮箱或密码不正确");

  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/accounts");
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();

  const restoreDrawer = await openAccountDrawer(page, "E2E 运营管理员");
  const restoreForm = accountStatusForm(createdUserId, restoreDrawer);
  await restoreForm.locator('input[name="reason"]').fill("E2E 恢复管理员");
  await confirmDialog(restoreForm, page, "恢复账号");
  await expect(page.getByText("账号已恢复。")).toBeVisible();
  await closeAccountDrawer(restoreDrawer);

  await expect.poll(async () => {
    const [user] = await db.select({ banned: authUsers.banned }).from(authUsers).where(eq(authUsers.id, createdUserId));
    return user?.banned;
  }).toBe(false);

  await signOutThroughShell(page);
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);

  await loginThroughUi(page, { email: updatedEmail, password: resetPassword });
  await expect(page).toHaveURL(/\/admin$/);
});

test("ordinary admins can manage customer details and multi-store operations", async ({ page }) => {
  await resetAdminManagementBaseline();
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
  await expect(page.getByLabel("客户编号")).toHaveCount(0);
  await expect(page.getByLabel("登录邮箱")).toHaveCount(0);
  await page.getByRole("button", { name: "新建客户", exact: true }).click();
  const createCustomerDrawer = page.getByRole("dialog", { name: "新建客户" });
  await expect(createCustomerDrawer).toBeVisible();
  await createCustomerDrawer.getByLabel("客户编号").fill(customerCode);
  await createCustomerDrawer.getByLabel("客户名称").fill(`多店客户 ${suffix}`);
  await createCustomerDrawer.getByLabel("店铺名称").fill(firstStoreName);
  await createCustomerDrawer.getByLabel("登录邮箱").fill(customerEmail);
  await createCustomerDrawer.getByLabel("初始密码").fill(customerPassword);
  await createCustomerDrawer.getByLabel("创建原因").fill("E2E 创建客户和首店");
  await createCustomerDrawer.getByRole("button", { name: "创建客户与店铺" }).click();
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
    await db.select({ id: customers.id }).from(customers).where(eq(customers.code, customerCode))
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

  await closeAccountDrawer(createCustomerDrawer);

  const customerDetailsLink = page.getByRole("link", {
    name: `查看 多店客户 ${suffix} 详情`,
  });
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await expect(page.locator("[data-customer-cards]")).toBeVisible();
    await expect(page.locator("[data-customer-table]")).not.toBeVisible();
    await expect(customerDetailsLink).toContainText(customerCode);
    await expect(customerDetailsLink).toContainText(customerEmail);
    await expect(customerDetailsLink).toContainText("1 家");

    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ height: 844, width });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ height: 844, width: 390 });
  } else {
    const row = page.getByRole("row", { name: new RegExp(customerCode) });
    await expect(page.locator("[data-customer-table]")).toBeVisible();
    await expect(row).toContainText(customerEmail);
    await expect(row).toContainText("1 家");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
  await customerDetailsLink.click();

  await expect(page).toHaveURL(new RegExp(`/admin/customers/${customerId}$`));
  await expect(page.getByRole("heading", { name: `多店客户 ${suffix}` })).toBeVisible();
  await expect(page.getByText(customerEmail)).toBeVisible();
  await expect(page.getByRole("link", { name: "前往账号管理" })).toHaveAttribute(
    "href",
    `/admin/accounts?customerId=${customerId}`,
  );
  await expect(page.getByLabel("客户名称")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存客户资料" })).toHaveCount(0);
  await expect(page.locator('form:has(input[name="storeId"])')).toHaveCount(0);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ height: 844, width });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({
    height: (page.viewportSize()?.height ?? 844),
    width: test.info().project.name === "mobile-chromium" ? 390 : 1440,
  });
  const detailAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    detailAccessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);

  const customerDrawer = await openCustomerEditDrawer(page);
  const customerForm = customerProfileForm(customerId, customerDrawer);
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
  await closeAccountDrawer(customerDrawer);

  await page.getByRole("tab", { name: "店铺" }).click();
  await expect(page.getByRole("button", { name: "新增店铺" })).toBeVisible();
  await expect(page.locator('form:has(input[name="storeId"])')).toHaveCount(0);

  await page.getByRole("button", { name: "新增店铺" }).click();
  const createStoreDrawer = page.getByRole("dialog", { name: "新增店铺" });
  await expect(createStoreDrawer).toBeVisible();
  const createStoreForm = addStoreForm(customerId, createStoreDrawer);
  await createStoreForm.getByLabel("店铺名称").fill(secondStoreName);
  await createStoreForm.getByLabel("平台").fill("TEMU");
  await createStoreForm.getByLabel("外部店铺编号").fill(`TEMU-${suffix}-002`);
  await createStoreForm.getByLabel("创建原因").fill("E2E 新增第二家店铺");
  await createStoreForm.getByRole("button", { name: "创建店铺" }).click();
  await expect(page.getByText("店铺已新增。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db.select({ id: stores.id }).from(stores).where(eq(stores.name, secondStoreName));
    return store?.id ?? null;
  }).not.toBeNull();
  const secondStoreId = (
    await db.select({ id: stores.id }).from(stores).where(eq(stores.name, secondStoreName))
  )[0]!.id;

  await expect.poll(async () => {
    const customerStores = await db.select({ id: stores.id }).from(stores).where(eq(stores.customerId, customerId));
    return customerStores.length;
  }).toBe(2);
  await closeAccountDrawer(createStoreDrawer);

  const updateStoreDrawer = await openStoreDrawer(page, secondStoreName);
  const updateStoreForm = storeUpdateForm(secondStoreId, updateStoreDrawer);
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
      .where(eq(stores.id, secondStoreId));
    return store;
  }).toMatchObject({
    externalStoreCode: `TEMU-${suffix}-002-UPDATED`,
    name: secondStoreUpdatedName,
  });
  await closeAccountDrawer(updateStoreDrawer);

  const disableStoreDrawer = await openStoreDrawer(page, secondStoreUpdatedName);
  const disableStoreForm = storeStatusForm(secondStoreId, "DISABLED", disableStoreDrawer);
  await disableStoreForm.getByLabel("操作原因").fill("E2E 停用第二家店铺");
  await confirmDialog(disableStoreForm, page, "停用店铺");
  await expect(page.getByText("店铺已停用。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db.select({ status: stores.status }).from(stores).where(eq(stores.id, secondStoreId));
    return store?.status;
  }).toBe("DISABLED");
  await closeAccountDrawer(disableStoreDrawer);

  const restoreStoreDrawer = await openStoreDrawer(page, secondStoreUpdatedName);
  const restoreStoreForm = storeStatusForm(secondStoreId, "ACTIVE", restoreStoreDrawer);
  await restoreStoreForm.getByLabel("操作原因").fill("E2E 恢复第二家店铺");
  await confirmDialog(restoreStoreForm, page, "恢复店铺");
  await expect(page.getByText("店铺已恢复。")).toBeVisible();

  await expect.poll(async () => {
    const [store] = await db.select({ status: stores.status }).from(stores).where(eq(stores.id, secondStoreId));
    return store?.status;
  }).toBe("ACTIVE");
  await closeAccountDrawer(restoreStoreDrawer);

  const customerAuthUserId = (
    await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, customerEmail))
  )[0]!.id;
  const disableCustomerDrawer = await openCustomerEditDrawer(page);
  const disableCustomerForm = customerStatusForm(customerId, "DISABLED", disableCustomerDrawer);
  await disableCustomerForm.getByLabel("操作原因").fill("E2E 暂停客户合作");
  await confirmDialog(disableCustomerForm, page, "停用客户");
  await expect(page.getByText("客户已停用。")).toBeVisible();
  await expect.poll(async () => {
    const [customer] = await db
      .select({ status: customers.status })
      .from(customers)
      .where(eq(customers.id, customerId));
    const [mirror] = await db
      .select({ status: customerUsers.status })
      .from(customerUsers)
      .where(eq(customerUsers.customerId, customerId));
    const [authUser] = await db
      .select({ banned: authUsers.banned })
      .from(authUsers)
      .where(eq(authUsers.id, customerAuthUserId));
    return { authBanned: authUser?.banned, customerStatus: customer?.status, mirrorStatus: mirror?.status };
  }).toEqual({ authBanned: true, customerStatus: "DISABLED", mirrorStatus: "DISABLED" });
  await expect.poll(async () => {
    const sessions = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, customerAuthUserId));
    return sessions.length;
  }).toBe(0);
  await closeAccountDrawer(disableCustomerDrawer);

  const restoreCustomerDrawer = await openCustomerEditDrawer(page);
  const restoreCustomerForm = customerStatusForm(customerId, "ACTIVE", restoreCustomerDrawer);
  await restoreCustomerForm.getByLabel("操作原因").fill("E2E 恢复客户合作");
  await confirmDialog(restoreCustomerForm, page, "恢复客户");
  await expect(page.getByText("客户已恢复。")).toBeVisible();
  await expect.poll(async () => {
    const [customer] = await db
      .select({ status: customers.status })
      .from(customers)
      .where(eq(customers.id, customerId));
    const [mirror] = await db
      .select({ status: customerUsers.status })
      .from(customerUsers)
      .where(eq(customerUsers.customerId, customerId));
    const [authUser] = await db
      .select({ banned: authUsers.banned })
      .from(authUsers)
      .where(eq(authUsers.id, customerAuthUserId));
    return { authBanned: authUser?.banned, customerStatus: customer?.status, mirrorStatus: mirror?.status };
  }).toEqual({ authBanned: false, customerStatus: "ACTIVE", mirrorStatus: "ACTIVE" });
  await closeAccountDrawer(restoreCustomerDrawer);

  await signOutThroughShell(page);
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

  await loginThroughUi(page, { email: customerEmail, password: customerPassword });
  await expect(page).toHaveURL(/\/portal$/);
});
