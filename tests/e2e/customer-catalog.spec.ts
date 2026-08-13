import ExcelJS from "exceljs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  customerSkuPrices,
  customers,
  inventoryBalances,
  inventoryReservations,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import { createTemuImportPreview } from "@/modules/order-import/service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";

import { createManagedUser, loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

function visibleCatalogItem(page: import("@playwright/test").Page, skuId: string) {
  return page.locator(`[data-testid="catalog-${skuId}"]:visible`);
}

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

async function previewWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");

  worksheet.addRow([...TEMU_EXPORT_HEADERS]);
  worksheet.addRow([
    "PO-PREVIEW-1",
    "加拿大",
    "待发货",
    "SUB-PREVIEW-1",
    1,
    "导入预览商品",
    "SKUID-1",
    "SKCID-1",
    "SPUID-1",
    "PREVIEW-SKU-1",
    "黑色",
    "Preview Recipient",
    "+1 613 555 0110",
    "",
    "preview@example.test",
    "",
    "",
    "300 Example Street",
    "",
    "",
    "Ottawa",
    "Ottawa",
    "Ontario",
    "K1A 0B1",
    "Canada",
    "",
    "",
    "",
    "2026-08-12 10:00:00",
    "2026-08-14 10:00:00",
    "",
    "",
    "",
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function seedImportPreview() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const [customer] = await db
    .insert(customers)
    .values({ code: `IMP-${suffix}`, name: `导入客户 ${suffix}` })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `TEMU 导入店 ${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `导入商品 ${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 760,
      name: "黑色",
      productId: product.id,
      skuCode: `PREVIEW-SKU-${suffix}`,
    })
    .returning();

  await db.insert(customerSkuPrices).values({
    customerId: customer.id,
    skuId: sku.id,
    unitPriceFen: 760,
  });
  await db.insert(skuAliases).values({
    externalSku: "PREVIEW-SKU-1",
    skuId: sku.id,
    storeId: store.id,
  });

  const user = await createManagedUser({ customerId: customer.id, role: "user" });
  const preview = await createTemuImportPreview({
    actorUserId: user.userId,
    buffer: await previewWorkbookBuffer(),
    customerId: customer.id,
    fileName: "preview-orders.xlsx",
    storeId: store.id,
  });

  return { preview, user };
}

test("customer sees only its own price and real available inventory", async ({ page }, testInfo) => {
  const fixture = await seedCustomerCatalog();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/);
  await page.goto("/portal/catalog");

  const availableRow = visibleCatalogItem(page, fixture.availableSku.id);
  await expect(availableRow).toContainText("¥7.60");
  await expect(availableRow).toContainText("可售 6");
  await expect(page.getByText("¥6.20")).toHaveCount(0);

  const soldOutRow = visibleCatalogItem(page, fixture.soldOutSku.id);
  await expect(soldOutRow).toContainText("不可售");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);

  await page.context().clearCookies();
  await resetE2EDatabaseToSeedState({
    context: "customer catalog visual baseline",
    database: db,
    reseed: seed,
  });
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal$/);
  await page.goto("/portal/catalog?q=TZX-DEMO-001");
  const seededRow = page
    .locator('[data-testid^="catalog-"]:visible')
    .filter({ hasText: "TZX-DEMO-001" });
  await expect(seededRow).toContainText("演示头绳");
  await expect(seededRow).toContainText("¥7.60");
  await expect(seededRow).toContainText("可售 10");
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page).toHaveScreenshot(`customer-catalog-${testInfo.project.name}.png`, {
    fullPage: true,
    maxDiffPixels: 30,
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
    await expect(visibleCatalogItem(page, fixture.availableSku.id)).toBeVisible();
    await expect(page.locator("[data-metric-strip]")).toHaveCount(0);
    await expect(page.locator("[data-customer-catalog-cards]")).toBeVisible();
    await expect(page.locator("[data-customer-catalog-table]")).not.toBeVisible();

    const searchInput = page.locator('input[name="q"]');
    await expect(searchInput).toBeVisible();
    const box = await searchInput.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }

  await page.getByRole("button", { name: "打开账号菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("customer import preview keeps re-upload navigation and unique heading metrics", async ({ page }) => {
  const fixture = await seedImportPreview();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/);
  await page.goto("/portal/imports/new");
  const uploadProgress = page.getByRole("navigation", { name: "订单导入进度" });
  await expect(uploadProgress.getByText("选择店铺")).toBeVisible();
  await expect(uploadProgress.getByText("上传文件")).toBeVisible();
  await expect(uploadProgress.getByText("校验预览")).toBeVisible();
  await expect(uploadProgress.getByText("确认提交")).toBeVisible();
  await expect(uploadProgress.getByText("上传文件").locator("..")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.goto(`/portal/imports/${fixture.preview.batchId}`);

  await expect(page.getByRole("heading", { name: "核对 TEMU 订单" })).toBeVisible();
  await expect(page.getByRole("link", { name: "重新上传" })).toBeVisible();
  const progress = page.getByRole("navigation", { name: "订单导入进度" });
  await expect(progress.getByText("选择店铺")).toBeVisible();
  await expect(progress.getByText("上传文件")).toBeVisible();
  await expect(progress.getByText("校验预览")).toBeVisible();
  await expect(progress.getByText("确认提交")).toBeVisible();
  await expect(progress.getByText("校验预览").locator("..")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByRole("region", { name: "当前导入" })).toContainText("preview-orders.xlsx");
  const recovery = page.getByRole("region", { name: "错误处理分类" });
  await expect(recovery).toContainText("可修复");
  await expect(recovery).toContainText("需管理员处理");
  await expect(recovery).toContainText("不可提交");
  const metricStrip = page.locator("[data-metric-strip]");
  await expect(metricStrip).toBeVisible();
  await expect(metricStrip.locator("article")).toHaveCount(4);
  await expect(metricStrip.getByText("可提交", { exact: true })).toHaveCount(1);
  await expect(metricStrip.getByText("重复订单", { exact: true })).toHaveCount(1);
  await expect(metricStrip.getByText("未知 SKU", { exact: true })).toHaveCount(1);
  await expect(metricStrip.getByText("格式错误", { exact: true })).toHaveCount(1);
});
