import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";

import { seed } from "@/db/seed";
import { db } from "@/db/client";

import { loginThroughUi } from "./support/managed-user";

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
    expectedTexts: ["合作客户", "TEMU 店铺", "在售 SKU", "当前可售件数", "10"],
    path: "/admin",
    screenshot: "admin-overview",
    shouldShowMetricStrip: true,
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
    heading: "货盘库存",
    expectedTexts: ["TZX-DEMO-001", "黑色 10 件装", "暂无基线"],
    path: "/admin/inventory",
    screenshot: "admin-inventory",
    shouldShowMetricStrip: true,
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
    heading: "欢迎使用同舟行跨境",
    expectedTexts: ["上传 TEMU 订单", "多店铺批量拿货", "快捷入口"],
    path: "/portal",
    screenshot: "customer-home",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "货盘选品",
    expectedTexts: ["TZX-DEMO-001", "¥7.60", "可售 10"],
    path: "/portal/catalog",
    screenshot: "customer-catalog",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "多店铺批量拿货",
    expectedTexts: ["还没有批量草稿", "新建批量草稿"],
    path: "/portal/bulk-orders",
    screenshot: "customer-bulk-orders",
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
  await db.execute(sql.raw(`
    truncate table
      system_notifications,
      integration_attempts,
      integration_outbox,
      replacement_requests,
      shipment_fulfillments,
      audit_logs,
      settlement_payment_claims,
      settlement_batch_orders,
      settlement_batches,
      wallet_holds,
      payment_claims,
      wallet_transactions,
      wallet_accounts,
      order_lines,
      order_shipments,
      fulfillment_orders,
      bulk_submission_requests,
      bulk_import_store_groups,
      bulk_import_drafts,
      order_import_rows,
      order_import_batches,
      inventory_movements,
      inventory_reservations,
      inventory_balances,
      sku_aliases,
      customer_sku_prices,
      auth_sessions,
      auth_accounts,
      auth_verifications,
      auth_users,
      customer_users,
      admin_users,
      stores,
      skus,
      products,
      customers
    restart identity cascade
  `));
  await seed();
}

test.describe.configure({ mode: "serial" });

for (const route of workspaceRoutes) {
  test(`${route.audience} workspace route ${route.path} uses the shared merchant-center visual structure`, async ({
    page,
  }, testInfo) => {
    await loginAsAudience(route.audience, page);
    await page.goto(route.path);

    await expect(page).toHaveURL(new RegExp(route.path.replace(/\//g, "\\/")));
    await expect(page.getByRole("banner")).toHaveAttribute("data-merchant-topbar", route.audience);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.locator("[data-page-heading]")).toBeVisible();
    await expect(page.locator("main")).toHaveCSS("background-color", "rgb(244, 245, 245)");

    if (route.shouldShowMetricStrip) {
      await expect(page.locator("[data-metric-strip]")).toBeVisible();
    }

    for (const text of route.expectedTexts) {
      await expectAnyVisibleText(page, text);
    }

    const workspacePanelCount = await page.locator("[data-workspace-panel]").count();
    expect(workspacePanelCount).toBeGreaterThan(0);

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

    await waitForVisualStability(page);
    await expect(page).toHaveScreenshot(`${route.screenshot}-${testInfo.project.name}.png`, {
      animations: "disabled",
      fullPage: false,
    });
  });
}
