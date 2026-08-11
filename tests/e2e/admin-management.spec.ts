import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import { customerSkuPrices, customers, skuAliases, skus } from "@/db/schema";
import { eq } from "drizzle-orm";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

test("an administrator can sign in and open the inventory workspace", async ({
  page,
}, testInfo) => {
  const admin = await createManagedUser({ role: "admin" });

  await loginThroughUi(page, admin);

  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "运营总览" }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await page.getByRole("button", { name: "打开导航" }).click();
  }
  await page.getByRole("link", { name: "货盘库存" }).click();
  await expect(page).toHaveURL(/\/admin\/inventory$/);
  await expect(
    page.getByRole("heading", { name: "货盘库存" }),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
  const viewport = page.viewportSize() ?? { height: 900, width: 1440 };
  await expect(page).toHaveScreenshot(`admin-inventory-${testInfo.project.name}.png`, {
    clip: {
      height: viewport.width < 1024 ? 490 : 300,
      width: viewport.width,
      x: 0,
      y: 0,
    },
  });
});

test("a customer cannot open administrator inventory", async ({ page }) => {
  const [customer] = await db
    .insert(customers)
    .values({
      code: `E2E-${crypto.randomUUID().slice(0, 12)}`,
      name: "E2E tenant",
    })
    .returning({ id: customers.id });
  const customerUser = await createManagedUser({
    customerId: customer.id,
    role: "user",
  });

  await loginThroughUi(page, customerUser);
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);
  await page.goto("/admin/inventory");

  await expect(page).toHaveURL(/\/portal(?:\/|$)/);
});

test("an administrator can create a sellable SKU and its initial inventory", async ({
  page,
}) => {
  const admin = await createManagedUser({ role: "admin" });
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const customerCode = `SHOP-${suffix}`;
  const skuCode = `TZX-${suffix}`;

  await loginThroughUi(page, admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/customers");
  await page.getByLabel("客户编号").fill("A");
  await page.getByLabel("客户名称").fill("X");
  await page.getByLabel("店铺名称").fill("Y");
  await page.getByLabel("登录邮箱").fill(`invalid-${suffix}@example.com`);
  await page.getByLabel("初始密码").fill("valid-test-password-2026");
  await page.getByRole("button", { name: "创建客户与店铺" }).click();
  const formAlert = page.getByRole("alert").filter({ hasText: "客户编号至少 2 个字符" });
  await expect(formAlert).toContainText("请填写客户名称");
  await expect(formAlert).toContainText("请填写店铺名称");
  await page.getByLabel("客户编号").fill(customerCode);
  await page.getByLabel("客户名称").fill(`测试客户 ${suffix}`);
  await page.getByLabel("店铺名称").fill(`TEMU 渥太华 ${suffix}`);
  await page.getByLabel("登录邮箱").fill(`customer-${suffix}@e2e.tongzhouxing.local`);
  await page.getByLabel("初始密码").fill("valid-test-password-2026");
  await page.getByRole("button", { name: "创建客户与店铺" }).click();
  await expect(page.getByText(customerCode)).toBeVisible();

  await page.goto("/admin/catalog");
  await page.getByLabel("标准 SKU", { exact: true }).fill(skuCode);
  await page.getByLabel("商品名称").fill(`测试商品 ${suffix}`);
  await page.getByLabel("规格名称").fill("红色");
  await page.getByLabel("统一拿货价（元）").fill("6.90");
  await page.getByRole("button", { name: "创建 SKU" }).click();
  await expect(page.getByRole("cell", { name: skuCode, exact: true })).toBeVisible();

  await page.getByLabel("专属价客户").selectOption({ label: customerCode });
  await page.getByLabel("专属价 SKU").selectOption({ label: skuCode });
  await page.getByLabel("客户价（元）").fill("7.60");
  await page.getByRole("button", { name: "保存专属价" }).click();
  await expect.poll(async () => {
    const [sku] = await db.select({ id: skus.id }).from(skus).where(eq(skus.skuCode, skuCode));
    const prices = await db.select().from(customerSkuPrices).where(eq(customerSkuPrices.skuId, sku.id));
    return prices[0]?.unitPriceFen;
  }).toBe(760);

  await page.getByLabel("别名店铺").selectOption({ label: `TEMU 渥太华 ${suffix}` });
  await page.getByLabel("映射标准 SKU").selectOption({ label: skuCode });
  await page.getByLabel("店铺导出 SKU").fill(`TEMU-${suffix}`);
  await page.getByRole("button", { name: "保存 SKU 映射" }).click();
  await expect.poll(async () => {
    const aliases = await db.select().from(skuAliases).where(eq(skuAliases.externalSku, `TEMU-${suffix}`));
    return aliases.length;
  }).toBe(1);

  await page.goto("/admin/inventory");
  await page.getByLabel("库存 SKU").selectOption({ label: skuCode });
  await page.getByLabel("调整数量").fill("10");
  await page.getByLabel("调整原因").fill("首批测试库存");
  await page.getByRole("button", { name: "确认调整库存" }).click();
  const inventoryRow = page.getByRole("row").filter({ hasText: skuCode });
  await expect(inventoryRow.getByRole("cell", { name: "10", exact: true })).toHaveCount(2);
});
