import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import {
  customerSkuPrices,
  customers,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

async function seedCustomerCatalog() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const productName = `客户货盘测试商品 ${suffix}`;
  const [customerA, customerB] = await db
    .insert(customers)
    .values([
      { code: `A-${suffix}`, name: `客户 A ${suffix}` },
      { code: `B-${suffix}`, name: `客户 B ${suffix}` },
    ])
    .returning({ id: customers.id });
  const [product] = await db
    .insert(products)
    .values({ name: productName })
    .returning({ id: products.id });
  const [availableSku, soldOutSku] = await db
    .insert(skus)
    .values([
      {
        defaultUnitPriceFen: 690,
        name: "红色",
        productId: product.id,
        skuCode: `TZX-A-${suffix}`,
      },
      {
        defaultUnitPriceFen: 520,
        name: "蓝色",
        productId: product.id,
        skuCode: `TZX-B-${suffix}`,
      },
    ])
    .returning({ id: skus.id, skuCode: skus.skuCode });
  await db.insert(customerSkuPrices).values([
    { customerId: customerA.id, skuId: availableSku.id, unitPriceFen: 760 },
    { customerId: customerB.id, skuId: availableSku.id, unitPriceFen: 620 },
  ]);
  await db.insert(inventoryBalances).values([
    { skuId: availableSku.id, totalQuantity: 10 },
    { skuId: soldOutSku.id, totalQuantity: 4 },
  ]);
  await db.insert(inventoryReservations).values([
    {
      quantity: 4,
      referenceId: `available-${suffix}`,
      referenceType: "E2E",
      skuId: availableSku.id,
    },
    {
      quantity: 4,
      referenceId: `sold-out-${suffix}`,
      referenceType: "E2E",
      skuId: soldOutSku.id,
    },
  ]);
  const user = await createManagedUser({ customerId: customerA.id, role: "user" });
  return { availableSku, productName, soldOutSku, user };
}

test("customer sees only its own price and real available inventory", async ({ page }, testInfo) => {
  const fixture = await seedCustomerCatalog();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/);
  await page.goto("/portal/catalog");

  const availableRow = page.getByTestId(`catalog-${fixture.availableSku.id}`);
  await expect(availableRow).toContainText("¥7.60");
  await expect(availableRow).toContainText("可售 6");
  await expect(page.getByText("¥6.20")).toHaveCount(0);

  const soldOutRow = page.getByTestId(`catalog-${fixture.soldOutSku.id}`);
  await expect(soldOutRow).toContainText("不可售");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);

  await page.goto(`/portal/catalog?q=${fixture.availableSku.skuCode}`);
  const isolatedRow = page.getByTestId(`catalog-${fixture.availableSku.id}`);
  await isolatedRow.waitFor();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page).toHaveScreenshot(`customer-catalog-${testInfo.project.name}.png`, {
    fullPage: true,
    maxDiffPixels: 5,
    maskColor: "#e8efed",
    mask: [
      page.getByLabel("搜索 SKU 或商品名称"),
      isolatedRow.getByText(fixture.availableSku.skuCode, { exact: true }),
      isolatedRow.getByText(fixture.productName, { exact: true }),
    ],
  });
});

test("customer catalog remains usable at approved mobile widths", async ({ page }) => {
  const fixture = await seedCustomerCatalog();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto("/portal/catalog");
    await expect(page.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "customer");
    await expect(page.getByRole("heading", { name: "货盘选品" })).toBeVisible();
    await expect(page.getByTestId(`catalog-${fixture.availableSku.id}`)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  await page.getByRole("button", { name: "打开账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
