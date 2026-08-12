import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { seed } from "@/db/seed";

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
    path: "/admin",
    screenshot: "admin-overview",
    shouldShowMetricStrip: true,
  },
  {
    audience: "admin" as const,
    heading: "订单管理",
    path: "/admin/orders",
    screenshot: "admin-orders",
    shouldShowMetricStrip: true,
  },
  {
    audience: "admin" as const,
    heading: "货盘库存",
    path: "/admin/inventory",
    screenshot: "admin-inventory",
    shouldShowMetricStrip: true,
  },
  {
    audience: "admin" as const,
    heading: "收款与余额",
    path: "/admin/settlement",
    screenshot: "admin-settlement",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "欢迎使用同舟行跨境",
    path: "/portal",
    screenshot: "customer-home",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "货盘选品",
    path: "/portal/catalog",
    screenshot: "customer-catalog",
    shouldShowMetricStrip: true,
  },
  {
    audience: "customer" as const,
    heading: "多店铺批量拿货",
    path: "/portal/bulk-orders",
    screenshot: "customer-bulk-orders",
    shouldShowMetricStrip: true,
  },
];

async function loginAsAudience(
  audience: "admin" | "customer",
  page: import("@playwright/test").Page,
) {
  await seed();
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
