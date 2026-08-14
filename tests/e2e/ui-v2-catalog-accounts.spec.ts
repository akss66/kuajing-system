import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import { inventoryBalances, products, skus } from "@/db/schema";
import { seed } from "@/db/seed";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
};

async function seedGroupedCatalog() {
  const [product] = await db
    .insert(products)
    .values({
      cargoUnitPriceMilliYuan: 1_366,
      linkText: "来源商品说明",
      name: "分组测试货品",
      sourceSequence: "1",
    })
    .returning({ id: products.id });

  const variants = await db
    .insert(skus)
    .values(
      ["1", "2", "3"].map((suffix) => ({
        defaultUnitPriceFen: 33,
        defaultUnitPriceMilliYuan: 325,
        name: `测试变体 ${suffix}`,
        productId: product!.id,
        productUrl: `https://example.test/products/1-${suffix}`,
        saleStatus: suffix === "2" ? ("NOT_SELLABLE" as const) : ("SELLABLE" as const),
        skuCode: `TZX-001-${suffix}`,
        specification: `规格 ${suffix}`,
      })),
    )
    .returning({ id: skus.id });

  await db.insert(inventoryBalances).values(
    variants.map((variant, index) => ({
      skuId: variant.id,
      totalQuantity: index + 1,
    })),
  );
}

async function expectNoSeriousAxeViolations(page: import("@playwright/test").Page) {
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

test("admin catalog groups source products across desktop search and mobile variants", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    const messageText = message.text();
    if (message.type() === "error") consoleErrors.push(messageText);
    if (/hydration|hydrated|did not match|server rendered/i.test(messageText)) {
      hydrationErrors.push(messageText);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await resetE2EDatabaseToSeedState({
    context: "grouped admin catalog E2E reset",
    database: db,
    reseed: seed,
  });
  await seedGroupedCatalog();
  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });

  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/admin/catalog");
  const table = page.getByRole("table", { name: "商品与 SKU 列表" });
  await expect(table).toBeVisible();
  await expect(table.getByText("序号 1", { exact: true })).toHaveCount(1);
  await expect(table.locator('td[rowspan="3"]')).toHaveCount(3);
  for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
    await expect(table.getByText(skuCode, { exact: true })).toBeVisible();
  }
  await page.getByRole("searchbox", { name: "搜索商品与 SKU" }).fill("TZX-001-2");
  for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
    await expect(table.getByText(skuCode, { exact: true })).toBeVisible();
  }

  const search = page.getByRole("searchbox", { name: "搜索商品与 SKU" });
  const saleStatusFilter = page.getByRole("group", { name: "销售状态筛选" });
  for (const label of ["全部", "可售", "不可售"]) {
    const control = saleStatusFilter.getByRole("button", { name: label, exact: true });
    await expect(control).toBeVisible();
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await search.fill("");
  await saleStatusFilter.getByRole("button", { name: "可售", exact: true }).click();
  await expect(table.getByText("TZX-001-1", { exact: true })).toBeVisible();
  await expect(table.getByText("TZX-001-3", { exact: true })).toBeVisible();
  await expect(table.getByText("TZX-001-2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2 个商品 / 3 个 SKU")).toBeVisible();

  await saleStatusFilter.getByRole("button", { name: "不可售", exact: true }).click();
  await expect(table.getByText("TZX-001-2", { exact: true })).toBeVisible();
  await expect(table.getByText("TZX-001-1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1 个商品 / 1 个 SKU")).toBeVisible();

  await saleStatusFilter.getByRole("button", { name: "全部", exact: true }).click();
  await search.fill("TZX-001-1");
  for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
    await expect(table.getByText(skuCode, { exact: true })).toBeVisible();
  }
  await saleStatusFilter.getByRole("button", { name: "不可售", exact: true }).click();
  await expect(table.getByText("TZX-001-2", { exact: true })).toBeVisible();
  await expect(table.getByText("TZX-001-1", { exact: true })).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  const cards = page.getByRole("list", { name: "商品与 SKU 卡片列表" });
  await expect(cards).toBeVisible();
  for (const label of ["全部", "可售", "不可售"]) {
    expect(
      (await saleStatusFilter.getByRole("button", { name: label, exact: true }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44);
  }
  await search.fill("");
  await saleStatusFilter.getByRole("button", { name: "可售", exact: true }).click();
  await expect(cards.getByText("TZX-001-1", { exact: true })).toBeVisible();
  await expect(cards.getByText("TZX-001-3", { exact: true })).toBeVisible();
  await expect(cards.getByText("TZX-001-2", { exact: true })).toHaveCount(0);
  await saleStatusFilter.getByRole("button", { name: "不可售", exact: true }).click();
  await expect(cards.getByText("TZX-001-2", { exact: true })).toBeVisible();
  await expect(cards.getByText("TZX-001-1", { exact: true })).toHaveCount(0);
  const groupedCard = cards.getByRole("listitem").filter({ hasText: "分组测试货品" });
  await expect(groupedCard).toHaveCount(1);
  const variantList = groupedCard.getByRole("list", { name: "分组测试货品 的 SKU 列表" });
  await expect(variantList.getByRole("listitem")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await expectNoSeriousAxeViolations(page);
  expect(consoleErrors).toEqual([]);
  expect(hydrationErrors).toEqual([]);
});
