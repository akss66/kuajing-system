import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { seed } from "@/db/seed";
import { db } from "@/db/client";
import { customers } from "@/db/schema";

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
    expectedTexts: ["库存健康", "低库存队列", "TZX-DEMO-001", "暂无基线", "最近库存变动"],
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
    expectedTexts: ["TZX-DEMO-001", "¥7.60", "可售 10"],
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
  await expect(page).toHaveURL(audience === "admin" ? /\/admin$/ : /\/portal$/);
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
