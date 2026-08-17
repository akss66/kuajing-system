import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { seed } from "@/db/seed";
import { db } from "@/db/client";
import {
  authUsers,
  authSessions,
  catalogAssets,
  customers,
  inventoryBalances,
  products,
  skus,
} from "@/db/schema";
import { commitCatalogAsset, stageCatalogAsset } from "@/modules/feishu/asset-storage";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
};

const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

const LONG_EMAIL =
  "field-aligned-account-with-a-deliberately-long-local-part-for-responsive-wrapping@operations.e2e.tongzhouxing.local";
const LONG_SPECIFICATION =
  "跨境仓配字段验收专用超长规格：适配加拿大冬季运输场景，包含加厚防潮内衬、可重复封装保护层、独立颜色标签与多件组合销售说明，用于验证桌面表格和移动卡片在真实长文本下仍能稳定换行且不侵入价格、库存与状态区域。";
const APPROVED_VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 1080, width: 1920 },
  { height: 900, width: 430 },
  { height: 844, width: 390 },
  { height: 800, width: 360 },
] as const;

const workspaceRoutes = [
  {
    audience: "admin" as const,
    heading: "运营总览",
    expectedTexts: ["今日经营", "待办与预警", "近 7 天趋势", "快捷处理"],
    path: "/admin",
    screenshot: "admin-overview",
    shouldShowMetricStrip: false,
  },
  {
    audience: "admin" as const,
    heading: "订单管理",
    expectedTexts: ["订单总数", "没有符合条件的拿货单。"],
    path: "/admin/orders",
    screenshot: "admin-orders",
    shouldShowMetricStrip: true,
  },
  {
    audience: "admin" as const,
    heading: "商品与 SKU",
    expectedTexts: ["TZX-DEMO-001", "演示头绳", "新建 SKU"],
    path: "/admin/catalog",
    screenshot: "admin-catalog",
    shouldShowMetricStrip: false,
    workspaceSelector: "[data-admin-catalog-workspace]",
  },
  {
    audience: "admin" as const,
    heading: "货盘库存",
    expectedTexts: [
      "实时库存",
      "库存流水",
      "库存健康",
      "低库存队列",
      "TZX-DEMO-001",
      "+ / - 调整",
    ],
    path: "/admin/inventory",
    screenshot: "admin-inventory",
    shouldShowMetricStrip: false,
    workspaceSelector: "[data-inventory-workspace]",
  },
  {
    audience: "admin" as const,
    heading: "收款与余额",
    expectedTexts: ["DEMO-CUSTOMER", "渥太华演示客户", "暂无资金流水。"],
    path: "/admin/settlement",
    screenshot: "admin-settlement",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "客户首页",
    expectedTexts: ["继续处理", "快捷拿货", "店铺摘要", "资金摘要"],
    path: "/portal",
    screenshot: "customer-home",
    shouldShowMetricStrip: false,
  },
  {
    audience: "customer" as const,
    heading: "货盘选品",
    expectedTexts: ["TZX-DEMO-001", "¥7.60", "10", "可售"],
    path: "/portal/catalog",
    screenshot: "customer-catalog",
    shouldShowMetricStrip: false,
    workspaceSelector: "[data-customer-catalog-workspace]",
  },
  {
    audience: "customer" as const,
    heading: "多店铺批量拿货",
    expectedTexts: ["还没有批量草稿", "新建批量草稿"],
    path: "/portal/bulk-orders",
    screenshot: "customer-bulk-orders",
    shouldShowMetricStrip: true,
  },
  {
    audience: "admin" as const,
    heading: "审计日志",
    expectedTexts: ["操作主体", "审计记录", "暂无审计记录"],
    path: "/admin/system/audit",
    screenshot: "admin-audit",
    shouldShowMetricStrip: false,
    workspaceSelector: "[data-workspace-panel]",
  },
  {
    audience: "customer" as const,
    heading: "上传 TEMU 订单",
    expectedTexts: ["选择店铺", "上传文件", "校验预览", "确认提交"],
    path: "/portal/imports/new",
    screenshot: "customer-import-flow",
    shouldShowMetricStrip: true,
  },
];

async function loginAsAudience(
  audience: "admin" | "customer",
  page: import("@playwright/test").Page,
) {
  await resetVisualBaseline();
  await loginThroughUi(page, audience === "admin" ? seededSuperAdmin : seededCustomer);
  await expect(page).toHaveURL(audience === "admin" ? /\/admin$/ : /\/portal$/, {
    timeout: 30_000,
  });
}

async function waitForVisualStability(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectAnyVisibleText(
  page: import("@playwright/test").Page,
  text: string,
) {
  const matches = page.getByText(text, { exact: false });

  await expect
    .poll(async () => {
      const count = await matches.count();
      for (let index = 0; index < count; index += 1) {
        if (await matches.nth(index).isVisible()) return true;
      }
      return false;
    })
    .toBe(true);
}

async function resetVisualBaseline() {
  await resetE2EDatabaseToSeedState({
    context: "merchant-center visual E2E reset",
    database: db,
    reseed: seed,
  });
}

async function waitForCatalogImages(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
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

async function createFieldAlignedVisualAsset() {
  const bytes = await sharp({
    create: {
      background: { alpha: 1, b: 146, g: 119, r: 41 },
      channels: 4,
      height: 48,
      width: 48,
    },
  })
    .png()
    .toBuffer();
  const manifest = await stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: "field-aligned-catalog.png",
    runId: `visual-${crypto.randomUUID()}`,
    skuCode: "TZX-034-1",
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
  if (!existingAsset) throw new Error("Visual catalog asset upsert did not return a row");
  return existingAsset;
}

async function seedFieldAlignedVisualCatalog() {
  const asset = await createFieldAlignedVisualAsset();
  const [product] = await db
    .insert(products)
    .values({
      linkText: "查看商品详情",
      name: "字段映射商品 34",
      sourceSequence: "34",
    })
    .returning({ id: products.id });
  const rows = await db
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
        name: "长规格变体",
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
        imageAssetId: asset.id,
        imageUrl: `/api/catalog-assets/${asset.id}`,
        name: "人工不可售变体",
        productId: product.id,
        productUrl: "https://example.test/products/34",
        saleStatus: "NOT_SELLABLE",
        skuCode: "TZX-034-2",
        specification: "人工不可售但仍有库存",
        weightGrams: 100,
      },
      {
        cargoUnitPriceMilliYuan: 1366,
        defaultUnitPriceFen: 520,
        defaultUnitPriceMilliYuan: 5200,
        imageAssetId: asset.id,
        imageUrl: `/api/catalog-assets/${asset.id}`,
        name: "售罄变体",
        productId: product.id,
        productUrl: "https://example.test/products/34",
        saleStatus: "SELLABLE",
        skuCode: "TZX-034-3",
        specification: "可售状态但当前库存为零",
      },
    ])
    .returning({ id: skus.id });
  await db.insert(inventoryBalances).values([
    { skuId: rows[0].id, totalQuantity: 8 },
    { skuId: rows[1].id, totalQuantity: 5 },
    { skuId: rows[2].id, totalQuantity: 0 },
  ]);
}

async function expectVisualRouteQuality(
  page: import("@playwright/test").Page,
  context: string,
) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    `${context} document overflow`,
  ).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
    `${context} serious/critical axe violations`,
  ).toEqual([]);
}

async function seededCustomerDetailRoute() {
  const [customer] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(eq(customers.code, "DEMO-CUSTOMER"))
    .limit(1);
  if (!customer) throw new Error("Visual baseline seed customer is missing");

  return {
    heading: customer.name,
    expectedTexts: ["可用余额", "店铺数量", "概览", "店铺", "订单与补发", "资金记录"],
    path: `/admin/customers/${customer.id}`,
    screenshot: "admin-customer-detail",
  };
}

test.describe.configure({ mode: "serial" });

test("field-aligned catalog and account screenshots cover the exact viewport matrix without masks @desktop-only", async ({
  page,
}) => {
  const failures = observeBrowserFailures(page);
  await resetVisualBaseline();
  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
  await db
    .update(authUsers)
    .set({ email: LONG_EMAIL })
    .where(eq(authUsers.role, "super_admin"));
  await db
    .update(authSessions)
    .set({ updatedAt: new Date("2026-08-14T00:37:00.000Z") });
  await seedFieldAlignedVisualCatalog();

  for (const viewport of APPROVED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/admin/catalog");
    await waitForCatalogImages(page);
    await expectAnyVisibleText(page, LONG_SPECIFICATION);
    await expectAnyVisibleText(page, "¥0.325");
    await expectAnyVisibleText(page, "¥1.366");
    await expectVisualRouteQuality(
      page,
      `/admin/catalog ${viewport.width}x${viewport.height}`,
    );
    await waitForVisualStability(page);
    await expect(page).toHaveScreenshot(
      `admin-catalog-${viewport.width}x${viewport.height}.png`,
      { animations: "disabled", fullPage: true },
    );

    await page.goto("/admin/accounts");
    await expectAnyVisibleText(page, LONG_EMAIL);
    await expectVisualRouteQuality(
      page,
      `/admin/accounts ${viewport.width}x${viewport.height}`,
    );
    await waitForVisualStability(page);
    await expect(page).toHaveScreenshot(
      `admin-accounts-${viewport.width}x${viewport.height}.png`,
      { animations: "disabled", fullPage: true },
    );
  }

  await page.context().clearCookies();
  await resetVisualBaseline();
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal$/, { timeout: 30_000 });
  await seedFieldAlignedVisualCatalog();
  for (const viewport of APPROVED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/portal/catalog?q=TZX-034");
    await waitForCatalogImages(page);
    await expectAnyVisibleText(page, LONG_SPECIFICATION);
    await expectAnyVisibleText(page, "不可售");
    await expectAnyVisibleText(page, "售罄");
    await expectVisualRouteQuality(
      page,
      `/portal/catalog ${viewport.width}x${viewport.height}`,
    );
    await waitForVisualStability(page);
    await expect(page).toHaveScreenshot(
      `customer-catalog-${viewport.width}x${viewport.height}.png`,
      { animations: "disabled", fullPage: true },
    );
  }

  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);
});

for (const route of workspaceRoutes) {
  test(`${route.audience} workspace route ${route.path} uses the shared merchant-center visual structure`, async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await loginAsAudience(route.audience, page);
    await page.goto(route.path);

    await expect(page).toHaveURL(new RegExp(route.path.replace(/\//g, "\\/")));
    await expect(page.getByRole("banner")).toHaveAttribute("data-merchant-topbar", route.audience);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.locator("[data-page-heading]")).toBeVisible();
    await expect(page.locator("main")).toHaveCSS("background-color", "rgb(244, 245, 245)");

    if (route.shouldShowMetricStrip) {
      await expect(page.locator("[data-metric-strip]")).toBeVisible();
    } else {
      await expect(page.locator("[data-metric-strip]")).toHaveCount(0);
    }

    for (const text of route.expectedTexts) {
      await expectAnyVisibleText(page, text);
    }

    if (route.workspaceSelector) {
      await expect(page.locator(route.workspaceSelector)).toBeVisible();
    } else {
      const workspacePanelCount = await page.locator("[data-workspace-panel]").count();
      expect(workspacePanelCount).toBeGreaterThan(0);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await waitForVisualStability(page);
    await expect(page).toHaveScreenshot(`${route.screenshot}-${testInfo.project.name}.png`, {
      animations: "disabled",
      fullPage: false,
    });
  });
}

test("admin business-detail visual uses the read-only customer workspace", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await loginAsAudience("admin", page);
  const route = await seededCustomerDetailRoute();
  await page.goto(route.path);

  await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("button", { exact: true, name: "保存客户资料" })).toHaveCount(0);
  await expect(page.getByRole("button", { exact: true, name: "保存店铺资料" })).toHaveCount(0);
  for (const text of route.expectedTexts) await expectAnyVisibleText(page, text);
  await expect(page.locator("[data-workspace-panel]").first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await waitForVisualStability(page);
  await expect(page).toHaveScreenshot(`${route.screenshot}-${testInfo.project.name}.png`, {
    animations: "disabled",
    fullPage: false,
  });
});

for (const dashboard of [
  {
    audience: "admin" as const,
    actionSectionId: "quick-actions-title",
    path: "/admin",
    firstSectionId: "today-operations-title",
    summarySectionId: "operations-trend-title",
  },
  {
    audience: "customer" as const,
    actionSectionId: "continuation-title",
    path: "/portal",
    firstSectionId: "continuation-title",
    summarySectionId: "store-summary-title",
  },
]) {
  test(`${dashboard.audience} dashboard fits 360, 390, and 430px @mobile-only`, async ({
    page,
  }) => {
    await loginAsAudience(dashboard.audience, page);

    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ height: 844, width });
      await page.goto(dashboard.path);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${dashboard.path} overflowed at ${width}px`).toBeLessThanOrEqual(1);

      const firstSection = page.locator(
        `section[aria-labelledby="${dashboard.firstSectionId}"]`,
      );
      const summarySection = page.locator(
        `section[aria-labelledby="${dashboard.summarySectionId}"]`,
      );
      await expect(firstSection).toBeVisible();
      const firstBox = await firstSection.boundingBox();
      const summaryBox = await summarySection.boundingBox();
      expect(firstBox).not.toBeNull();
      expect(summaryBox).not.toBeNull();
      expect(firstBox!.y).toBeLessThan(summaryBox!.y);

      const actionBox = await page
        .locator(`section[aria-labelledby="${dashboard.actionSectionId}"] a`)
        .first()
        .boundingBox();
      expect(actionBox).not.toBeNull();
      expect(actionBox!.height).toBeGreaterThanOrEqual(44);

      if (dashboard.audience === "customer") {
        expect(summaryBox!.y).toBeGreaterThanOrEqual(844);
      }
    }
  });
}
