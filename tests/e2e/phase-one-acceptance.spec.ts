import { expect, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import {
  authAccounts,
  authSessions,
  authUsers,
  customerUsers,
  customers,
  customerSkuPrices,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  products,
  skuAliases,
  skus,
  stores,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

async function cleanupPhaseFixture() {
  const [sku] = await db
    .select({ id: skus.id, productId: skus.productId })
    .from(skus)
    .where(eq(skus.skuCode, "TZX-DEMO-001"));
  if (sku) {
    await db.delete(inventoryMovements).where(eq(inventoryMovements.skuId, sku.id));
    await db.delete(inventoryReservations).where(eq(inventoryReservations.skuId, sku.id));
    await db.delete(inventoryBalances).where(eq(inventoryBalances.skuId, sku.id));
    await db.delete(skuAliases).where(eq(skuAliases.skuId, sku.id));
    await db.delete(customerSkuPrices).where(eq(customerSkuPrices.skuId, sku.id));
    await db.delete(skus).where(eq(skus.id, sku.id));
    await db.delete(products).where(eq(products.id, sku.productId));
  }
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.code, "PHASE-DEMO"));
  if (customer) {
    const users = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.customerId, customer.id));
    const userIds = users.map((item) => item.id);
    if (userIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.userId, userIds));
      await db.delete(authAccounts).where(inArray(authAccounts.userId, userIds));
      await db.delete(authUsers).where(inArray(authUsers.id, userIds));
    }
    await db
      .delete(walletTransactions)
      .where(eq(walletTransactions.customerId, customer.id));
    await db
      .delete(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    await db
      .delete(customerUsers)
      .where(eq(customerUsers.customerId, customer.id));
    await db.delete(stores).where(eq(stores.customerId, customer.id));
    await db.delete(customers).where(eq(customers.id, customer.id));
  }
}

test("phase one customer, price and inventory flow is operational @desktop-only", async ({ page }) => {
  await cleanupPhaseFixture();
  const admin = await createManagedUser({ role: "admin" });
  const customerEmail = "phase-customer@e2e.tongzhouxing.local";
  const customerPassword = "valid-test-password-2026";

  await loginThroughUi(page, admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/customers");
  await page.getByRole("button", { name: "新建客户" }).click();
  let drawer = page.getByRole("dialog", { name: "新建客户" });
  await drawer.getByLabel("客户编号").fill("PHASE-DEMO");
  await drawer.getByLabel("客户名称").fill("阶段一验收客户");
  await drawer.getByLabel("店铺名称").fill("TEMU 阶段一验收店");
  await drawer.getByLabel("登录邮箱").fill(customerEmail);
  await drawer.getByLabel("初始密码").fill(customerPassword);
  await drawer.getByLabel("创建原因").fill("E2E 阶段一验收初始化客户与首店");
  await drawer.getByRole("button", { name: "创建客户与店铺" }).click();
  await expect(page.getByText("客户与首家店铺已创建。")).toBeVisible();

  await page.goto("/admin/catalog");
  await page.getByRole("button", { name: "新建 SKU" }).click();
  drawer = page.getByRole("dialog", { name: "新建 SKU" });
  await drawer.getByLabel("创建方式").selectOption("CREATE");
  await drawer.getByLabel("序号").fill("900");
  await drawer.getByLabel("商品名称").fill("阶段一验收商品");
  await drawer.getByLabel("货品价格（元）").fill("6.90");
  await drawer.getByLabel("SKU", { exact: true }).fill("TZX-DEMO-001");
  await drawer.getByLabel("采购价（元）").fill("2.50");
  await drawer.getByLabel("初始库存（份）").fill("0");
  await drawer.getByLabel("规格").fill("红色");
  await drawer.getByLabel("重量（克）").fill("0");
  await drawer.getByLabel("创建原因").fill("E2E 阶段一验收新增商品与 SKU");
  await drawer.getByRole("button", { name: "创建 SKU" }).click();
  await expect(drawer.getByText("SKU 已创建，商品资料与初始库存已保存。")).toBeVisible();
  await drawer.getByRole("button", { name: "关闭" }).click();
  await expect(
    page.getByRole("table", { name: "商品与 SKU 列表" }).getByText("TZX-DEMO-001", { exact: true }),
  ).toBeVisible();

  await page.goto("/admin/inventory");
  await page.getByRole("button", { name: "+ / - 调整 TZX-DEMO-001" }).click();
  drawer = page.getByRole("dialog", { name: "TZX-DEMO-001 调整库存" });
  await drawer.getByLabel("调整数量").fill("10");
  await drawer.getByLabel("备注（可选）").fill("首批测试库存");
  await drawer.getByRole("button", { name: "确认调整库存" }).click();
  await expect(drawer.getByText("库存已调整并记录流水。")).toBeVisible();
  await page.goto("/admin/system/audit?action=INVENTORY_ADJUSTED");
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "库存调整" }).first()).toBeVisible();
  await page.goto("/admin/inventory?view=movements&sku=TZX-DEMO-001");
  await expect(page.getByRole("table", { name: "库存流水列表" })).toContainText(
    "首批测试库存",
  );

  await page.context().clearCookies();
  await loginThroughUi(page, { email: customerEmail, password: customerPassword });
  await expect(page).toHaveURL(/\/portal/);
  await page.goto("/portal/catalog?q=TZX-DEMO-001");
  const [sku] = await db
    .select({ id: skus.id })
    .from(skus)
    .where(eq(skus.skuCode, "TZX-DEMO-001"));
  const row = page.locator(`[data-testid="catalog-${sku.id}"]:visible`);
  await expect(row).toContainText("¥6.90");
  await expect(row.getByRole("cell", { name: "10", exact: true })).toBeVisible();
  await expect(row.getByText("可售", { exact: true })).toBeVisible();
});
