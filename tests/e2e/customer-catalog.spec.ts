import ExcelJS from "exceljs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  catalogAssets,
  customerSkuPrices,
  customers,
  inventoryBalances,
  inventoryReservations,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import { commitCatalogAsset, stageCatalogAsset } from "@/modules/feishu/asset-storage";
import { createTemuImportPreview } from "@/modules/order-import/service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";

import { createManagedUser, loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

const LONG_SPECIFICATION =
  "跨境仓配字段验收专用超长规格：适配加拿大冬季运输场景，包含加厚防潮内衬、可重复封装保护层、独立颜色标签与多件组合销售说明，用于验证桌面表格和移动卡片在真实长文本下仍能稳定换行且不侵入价格、库存与状态区域。";
const APPROVED_VIEWPORTS = [
  { height: 900, kind: "desktop", width: 1440 },
  { height: 1080, kind: "desktop", width: 1920 },
  { height: 900, kind: "mobile", width: 430 },
  { height: 844, kind: "mobile", width: 390 },
  { height: 800, kind: "mobile", width: 360 },
] as const;

function visibleCatalogItem(page: import("@playwright/test").Page, skuId: string) {
  return page.locator(`[data-testid="catalog-${skuId}"]:visible`);
}

async function createCatalogImage(seedValue: number) {
  const bytes = await sharp({
    create: {
      background: {
        alpha: 1,
        b: (seedValue * 37) % 255,
        g: (seedValue * 19) % 255,
        r: (seedValue * 11) % 255,
      },
      channels: 4,
      height: 12,
      width: 12,
    },
  })
    .png()
    .toBuffer();
  const manifest = await stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: `catalog-${seedValue}.png`,
    runId: `catalog-${crypto.randomUUID().slice(0, 8)}`,
    skuCode: `CATALOG-${seedValue}`,
  });
  const storageKey = await commitCatalogAsset(manifest);
  const [insertedAsset] = await db
    .insert(catalogAssets)
    .values({
      byteSize: manifest.byteSize,
      contentSha256: manifest.contentSha256,
      mimeType: manifest.mimeType,
      originalFileName: manifest.originalFileName,
      storageKey,
    })
    .onConflictDoNothing()
    .returning({ id: catalogAssets.id });
  if (insertedAsset) return insertedAsset;
  const [existingAsset] = await db
    .select({ id: catalogAssets.id })
    .from(catalogAssets)
    .where(eq(catalogAssets.contentSha256, manifest.contentSha256))
    .limit(1);
  if (!existingAsset) throw new Error("Catalog asset upsert did not return a row");
  return existingAsset;
}

async function seedCustomerCatalog() {
  await resetE2EDatabaseToSeedState({
    context: "field-aligned customer catalog E2E reset",
    database: db,
    reseed: seed,
  });
  const suffix = "FIELDALIGNED";
  const asset = await createCatalogImage(34);
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
    .values({
      linkText: "查看商品详情",
      name: productName,
      sourceSequence: "34",
    })
    .returning({ id: products.id });
  const [availableSku, manualUnavailableSku, soldOutSku] = await db
    .insert(skus)
    .values([
      {
        cargoUnitPriceMilliYuan: 1366,
        color: "深海青",
        combination: "三件组合",
        defaultUnitPriceFen: 33,
        defaultUnitPriceMilliYuan: 325,
        imageAssetId: asset.id,
        imageUrl: `/api/catalog-assets/${asset.id}`,
        name: "SKU 名称不能冒充规格",
        productId: product.id,
        productUrl: "https://example.test/products/34",
        saleStatus: "SELLABLE",
        skuCode: "TZX-034-1",
        specification: LONG_SPECIFICATION,
        weightGrams: 325,
      },
      {
        cargoUnitPriceMilliYuan: 1366,
        color: "红色",
        combination: "单个",
        defaultUnitPriceFen: 137,
        defaultUnitPriceMilliYuan: 1366,
        name: "人工不可售变体",
        productId: product.id,
        productUrl: "https://example.test/products/34",
        saleStatus: "NOT_SELLABLE",
        skuCode: "TZX-034-2",
        specification: "人工不可售但仍保留库存",
        weightGrams: 100,
      },
      {
        cargoUnitPriceMilliYuan: 1366,
        defaultUnitPriceFen: 520,
        defaultUnitPriceMilliYuan: 5200,
        name: "蓝色",
        productId: product.id,
        productUrl: "https://example.test/products/34",
        saleStatus: "SELLABLE",
        skuCode: "TZX-034-3",
        specification: "可售状态但当前库存为零",
      },
    ])
    .returning({ id: skus.id, skuCode: skus.skuCode });
  await db.insert(customerSkuPrices).values([
    {
      customerId: customerA.id,
      skuId: availableSku.id,
      unitPriceFen: 760,
      unitPriceMilliYuan: 7600,
    },
    {
      customerId: customerB.id,
      skuId: availableSku.id,
      unitPriceFen: 620,
      unitPriceMilliYuan: 6200,
    },
  ]);
  await db.insert(inventoryBalances).values([
    { skuId: availableSku.id, totalQuantity: 10 },
    { skuId: manualUnavailableSku.id, totalQuantity: 5 },
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
  return {
    availableSku,
    manualUnavailableSku,
    productId: product.id,
    productName,
    soldOutSku,
    user,
  };
}

function observeBrowserFailures(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/hydration|hydrated|did not match|server rendered/i.test(text)) {
      hydrationErrors.push(`${message.type()}: ${text}`);
    }
    if (message.type() === "error") consoleErrors.push(text);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, hydrationErrors, pageErrors };
}

async function expectNoOverlap(left: import("@playwright/test").Locator, right: import("@playwright/test").Locator, context: string) {
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox, `${context} left bounding box`).not.toBeNull();
  expect(rightBox, `${context} right bounding box`).not.toBeNull();
  const intersectionWidth = Math.max(
    0,
    Math.min(leftBox!.x + leftBox!.width, rightBox!.x + rightBox!.width) -
      Math.max(leftBox!.x, rightBox!.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftBox!.y + leftBox!.height, rightBox!.y + rightBox!.height) -
      Math.max(leftBox!.y, rightBox!.y),
  );
  expect(intersectionWidth * intersectionHeight, `${context} overlap area`).toBeLessThanOrEqual(1);
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
    "TZX-PREVIEW-1",
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
      cargoUnitPriceMilliYuan: 7600,
      defaultUnitPriceFen: 760,
      defaultUnitPriceMilliYuan: 7600,
      name: "黑色",
      productId: product.id,
      skuCode: `TZX-PREVIEW-${suffix}`,
    })
    .returning();

  await db.insert(customerSkuPrices).values({
    customerId: customer.id,
    skuId: sku.id,
    unitPriceFen: 760,
    unitPriceMilliYuan: 7600,
  });
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: 10,
  });
  await db.insert(skuAliases).values({
    externalSku: "TZX-PREVIEW-1",
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
  const failures = observeBrowserFailures(page);
  const fixture = await seedCustomerCatalog();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
  await page.goto("/portal/catalog");

  const sortControl = page.getByRole("combobox", { name: "货盘排序方式" });
  await expect(sortControl).toContainText("SKU 顺序");
  const sortControlBox = await sortControl.boundingBox();
  expect(sortControlBox).not.toBeNull();
  expect(sortControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const fixtureProduct = page.locator(
    `[data-testid="catalog-product-${fixture.productId}"]:visible`,
  );
  const visibleVariantOrder = () =>
    fixtureProduct.locator('[data-testid^="catalog-"]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    );
  await expect.poll(visibleVariantOrder).toEqual([
    `catalog-${fixture.availableSku.id}`,
    `catalog-${fixture.manualUnavailableSku.id}`,
    `catalog-${fixture.soldOutSku.id}`,
  ]);

  await sortControl.click();
  await page.getByRole("option", { name: "货价：从高到低" }).click();
  await expect.poll(visibleVariantOrder).toEqual([
    `catalog-${fixture.availableSku.id}`,
    `catalog-${fixture.manualUnavailableSku.id}`,
    `catalog-${fixture.soldOutSku.id}`,
  ]);

  await sortControl.click();
  await page.getByRole("option", { name: "货价：从低到高" }).click();
  await expect.poll(visibleVariantOrder).toEqual([
    `catalog-${fixture.availableSku.id}`,
    `catalog-${fixture.manualUnavailableSku.id}`,
    `catalog-${fixture.soldOutSku.id}`,
  ]);

  const availableRow = visibleCatalogItem(page, fixture.availableSku.id);
  const protectedImage = availableRow.locator("img").first();
  await expect(availableRow).toContainText("¥1.366");
  await expect(availableRow.getByText("6", { exact: true })).toBeVisible();
  await expect(page.getByText("¥6.20")).toHaveCount(0);

  await expect(protectedImage).toBeVisible();
  const protectedImageUrl = await protectedImage.getAttribute("src");
  expect(protectedImageUrl).toMatch(/^\/api\/catalog-assets\//);
  const protectedImageResponse = await page.context().request.get(
    new URL(protectedImageUrl ?? "", page.url()).toString(),
  );
  expect(protectedImageResponse.status()).toBe(200);
  await expect
    .poll(() => protectedImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await availableRow.getByRole("button", { name: `查看 ${fixture.productName} 大图` }).click();
  const imagePreview = page.getByRole("dialog", { name: `${fixture.productName} 图片预览` });
  await expect(imagePreview.getByRole("img", { name: `${fixture.productName} 大图` })).toBeVisible();
  await imagePreview.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(imagePreview).toHaveCount(0);

  const manualUnavailableRow = visibleCatalogItem(page, fixture.manualUnavailableSku.id);
  await expect(manualUnavailableRow.getByText("5", { exact: true })).toBeVisible();
  await expect(manualUnavailableRow).toContainText("不可售");
  const soldOutRow = visibleCatalogItem(page, fixture.soldOutSku.id);
  await expect(soldOutRow).toContainText("售罄");
  const saleStatusFilter = page.getByRole("group", { name: "销售状态筛选" });
  await expect(saleStatusFilter).toBeVisible();
  await saleStatusFilter.getByRole("button", { name: "只看不可售 SKU" }).click();
  await expect(availableRow).toHaveCount(0);
  await expect(manualUnavailableRow).toContainText("不可售");
  await expect(soldOutRow).toContainText("售罄");
  await expect(page.getByText("1 个商品 / 2 个 SKU")).toBeVisible();
  await expect(page.locator('[data-testid^="catalog-product-"]:visible')).toHaveCount(1);
  await saleStatusFilter.getByRole("button", { name: "只看可售 SKU" }).click();
  await expect(availableRow).toBeVisible();
  await expect(manualUnavailableRow).toHaveCount(0);
  await expect(soldOutRow).toHaveCount(0);
  await expect(page.getByText("2 个商品 / 2 个 SKU")).toBeVisible();
  await saleStatusFilter.getByRole("button", { name: "查看全部 SKU" }).click();
  await expect(availableRow).toContainText(LONG_SPECIFICATION);
  await expect(page.getByText("2 个商品 / 4 个 SKU")).toBeVisible();
  await expect(page.locator('[data-testid^="catalog-product-"]:visible')).toHaveCount(2);
  await expect(page.getByRole("heading", { name: fixture.productName })).toBeVisible();
  for (const internalLabel of ["序号", "采购价", "总库存", "货品价格"]) {
    await expect(page.getByText(internalLabel, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("link", { name: "查看商品详情" }).first()).toHaveAttribute(
    "rel",
    /noopener/,
  );

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);

  await page.goto("/portal/catalog?q=TZX-034-2");
  await expect(page.getByText("1 个商品 / 3 个 SKU")).toBeVisible();
  await expect(visibleCatalogItem(page, fixture.availableSku.id)).toBeVisible();
  await expect(visibleCatalogItem(page, fixture.manualUnavailableSku.id)).toBeVisible();
  await expect(visibleCatalogItem(page, fixture.soldOutSku.id)).toBeVisible();

  await page.context().clearCookies();
  await resetE2EDatabaseToSeedState({
    context: "customer catalog visual baseline",
    database: db,
    reseed: seed,
  });
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal$/);
  await page.goto("/portal/catalog?q=TZX-DEMO-001");
  const seededGroup = page.locator('[data-testid^="catalog-product-"]:visible');
  await expect(seededGroup).toContainText("演示头绳");
  await expect(seededGroup).toContainText("TZX-DEMO-001");
  await expect(seededGroup).toContainText("¥7.60");
  await expect(seededGroup.getByText("10", { exact: true })).toBeVisible();
  await expect(seededGroup).toContainText("可售");
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page).toHaveScreenshot(`customer-catalog-${testInfo.project.name}.png`, {
    fullPage: true,
    maxDiffPixels: 30,
  });
});

test("customer catalog passes the exact five-viewport field-aligned matrix @desktop-only", async ({ page }) => {
  const failures = observeBrowserFailures(page);
  const fixture = await seedCustomerCatalog();
  await loginThroughUi(page, fixture.user);
  await expect(page).toHaveURL(/\/portal/);

  for (const viewport of APPROVED_VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto("/portal/catalog");
    if (viewport.width >= 1024) {
      await expect(page.getByRole("banner")).toHaveCount(0);
      await expect(page.locator("[data-merchant-sidebar]")).toBeVisible();
    } else {
      await expect(page.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "customer");
    }
    await expect(page.getByRole("heading", { exact: true, name: "实时货盘" })).toBeVisible();
    await expect(visibleCatalogItem(page, fixture.availableSku.id)).toBeVisible();
    await expect(visibleCatalogItem(page, fixture.manualUnavailableSku.id)).toContainText("不可售");
    await expect(visibleCatalogItem(page, fixture.soldOutSku.id)).toContainText("售罄");
    await expect(page.getByText("2 个商品 / 4 个 SKU")).toBeVisible();
    await expect(page.locator('[data-testid^="catalog-product-"]:visible')).toHaveCount(2);
    await expect(page.locator("[data-metric-strip]")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "客户货盘卡片列表" })).toBeVisible();
    await expect(page.locator("[data-customer-catalog-table]")).toHaveCount(0);

    const searchInput = page.locator('input[name="q"]');
    await expect(searchInput).toBeVisible();
    const box = await searchInput.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    const saleStatusFilter = page.getByRole("group", { name: "销售状态筛选" });
    await expect(saleStatusFilter).toBeVisible();
    for (const buttonName of ["查看全部 SKU", "只看可售 SKU", "只看不可售 SKU"]) {
      const filterButton = saleStatusFilter.getByRole("button", { name: buttonName });
      await expect(filterButton).toBeVisible();
      const filterButtonBox = await filterButton.boundingBox();
      expect(filterButtonBox).not.toBeNull();
      expect(filterButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await saleStatusFilter.getByRole("button", { name: "只看可售 SKU" }).click();
    await expect(visibleCatalogItem(page, fixture.availableSku.id)).toBeVisible();
    await expect(visibleCatalogItem(page, fixture.manualUnavailableSku.id)).toHaveCount(0);
    await expect(visibleCatalogItem(page, fixture.soldOutSku.id)).toHaveCount(0);
    await expect(page.getByText("2 个商品 / 2 个 SKU")).toBeVisible();
    await saleStatusFilter.getByRole("button", { name: "只看不可售 SKU" }).click();
    await expect(visibleCatalogItem(page, fixture.availableSku.id)).toHaveCount(0);
    await expect(visibleCatalogItem(page, fixture.manualUnavailableSku.id)).toContainText("不可售");
    await expect(visibleCatalogItem(page, fixture.soldOutSku.id)).toContainText("售罄");
    await expect(page.getByText("1 个商品 / 2 个 SKU")).toBeVisible();
    await expect(page.locator('[data-testid^="catalog-product-"]:visible')).toHaveCount(1);
    await saleStatusFilter.getByRole("button", { name: "查看全部 SKU" }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const availableItem = visibleCatalogItem(page, fixture.availableSku.id);
    const specification = availableItem.locator("[title]").first();
    const price = availableItem.getByText("¥1.366", { exact: true });
    const inventory = availableItem.getByText("6", { exact: true });
    const status = availableItem.getByText("可售", { exact: true });
    await expectNoOverlap(specification, price, `${viewport.width}x${viewport.height} spec/price`);
    await expectNoOverlap(specification, inventory, `${viewport.width}x${viewport.height} spec/inventory`);
    await expectNoOverlap(specification, status, `${viewport.width}x${viewport.height} spec/status`);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((item) =>
        ["serious", "critical"].includes(item.impact ?? ""),
      ),
    ).toEqual([]);
  }

  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);

  await page.getByRole("button", { name: "打开账号菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("customer import preview uses the compact review workspace and sticky submit bar", async ({ page }, testInfo) => {
  const failures = observeBrowserFailures(page);
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
  await expect(page.getByRole("link", { name: "返回重新上传" })).toBeVisible();
  const progress = page.getByRole("navigation", { name: "订单导入进度" });
  await expect(progress.getByText("选择店铺")).toBeVisible();
  await expect(progress.getByText("上传文件")).toBeVisible();
  await expect(progress.getByText("校验预览")).toBeVisible();
  await expect(progress.getByText("确认提交")).toBeVisible();
  await expect(progress.getByText("校验预览").locator("..")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByText(/preview-orders\.xlsx/)).toBeVisible();
  const workspace = page.getByRole("region", { name: "逐行校验工作台" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("list", { name: "逐行校验结果" })).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    const workspaceWidth = await workspace.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(workspaceWidth.scrollWidth).toBeLessThanOrEqual(workspaceWidth.clientWidth + 1);
  }
  await expect(workspace.getByText("可提交", { exact: true })).toBeVisible();
  await expect(workspace.getByText("需处理", { exact: true })).toBeVisible();
  await expect(workspace.getByText("重复跳过", { exact: true })).toBeVisible();
  const submitBar = page.getByRole("region", { name: "提交拿货单操作栏" });
  await expect(submitBar).toBeVisible();
  const submitBarBox = await submitBar.boundingBox();
  expect(submitBarBox).not.toBeNull();
  expect((submitBarBox?.y ?? 0) + (submitBarBox?.height ?? 0)).toBeLessThanOrEqual(
    (page.viewportSize()?.height ?? 0) + 1,
  );

  const row = page.getByRole("listitem", { name: "Excel 第 2 行" });
  await expect(row.getByText("校验通过", { exact: true })).toBeVisible();
  await expect(row.getByText("TZX-PREVIEW-1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("同系列替代 SKU")).toHaveCount(0);
  await testInfo.attach("import-review-scheme-a-viewport", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await row.getByRole("button", { name: "修改 Excel 第 2 行" }).click();
  await expect(page.getByLabel("同系列替代 SKU")).toBeVisible();
  await expect(page.getByLabel("手动填写最终 SKU")).toBeVisible();
  await expect(page.getByLabel("实际发货数量")).toHaveValue("1");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);
  await testInfo.attach("import-review-scheme-a-expanded", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
