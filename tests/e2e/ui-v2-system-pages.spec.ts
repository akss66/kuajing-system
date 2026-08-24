import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { db } from "@/db/client";
import { auditLogs, integrationOutbox, systemNotifications } from "@/db/schema";
import { seed } from "@/db/seed";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const admin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
};

function observeBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function resetAndLogin(page: Page, context: string) {
  await resetE2EDatabaseToSeedState({ context, database: db, reseed: seed });
  await loginThroughUi(page, admin);
  await expect(page).toHaveURL(/\/admin$/);
}

async function expectPageQuality(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator('[data-metric-strip]')).toHaveCount(0);
  await expect(
    page.locator('nav[aria-label="管理员主导航"] [aria-current="page"]'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("replacements separate the action queue from completed history", async ({ page }) => {
  await resetAndLogin(page, "UI V2 replacements");
  await page.goto("/admin/replacements");

  await expect(page.getByRole("heading", { exact: true, name: "待处理补发" })).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "补发历史" })).toBeVisible();
  await expect(page.getByRole("status", { name: "当前没有待处理补发" })).toContainText(
    "查看已发货订单",
  );
  await expectPageQuality(page);
});

test("notifications communicate severity, impact and resolution state", async ({ page }) => {
  await resetAndLogin(page, "UI V2 notifications");
  await page.goto("/admin/notifications");

  await expect(page.getByRole("status", { name: "当前没有系统通知" })).toContainText(
    "查看系统健康",
  );

  await db.insert(systemNotifications).values([
    {
      deduplicationKey: `ui-v2-notification-open-${crypto.randomUUID()}`,
      entityId: "SKU-01",
      entityType: "SKU",
      message: "SKU 当前可售库存不足，请核对补货计划。",
      severity: "ERROR",
      status: "UNREAD",
      title: "库存覆盖不足",
      type: "STOCK_COVERAGE_CRITICAL",
    },
    {
      deduplicationKey: `ui-v2-notification-resolved-${crypto.randomUUID()}`,
      entityId: "ORDER-01",
      entityType: "FULFILLMENT_ORDER",
      message: "履约异常已经处理完成。",
      resolvedAt: new Date(),
      severity: "INFO",
      status: "RESOLVED",
      title: "履约异常已恢复",
      type: "FULFILLMENT_RECOVERED",
    },
  ]);
  await page.reload();

  await expect(page.getByRole("heading", { exact: true, name: "需要处理" })).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "已归档通知" })).toBeVisible();
  await expect(page.getByText("严重", { exact: true })).toBeVisible();
  await expect(page.getByText("影响库存", { exact: true })).toBeVisible();
  await expect(page.getByText("未读", { exact: true })).toBeVisible();
  await expect(page.getByText("已解决", { exact: true })).toBeVisible();
  await expect(page.getByText("ERROR", { exact: true })).toHaveCount(0);
  await expect(page.getByText("UNREAD", { exact: true })).toHaveCount(0);
  await expect(page.getByText("RESOLVED", { exact: true })).toHaveCount(0);
  await expectPageQuality(page);
});

test("integrations keep configuration state separate from failed task history", async ({ page }) => {
  await resetAndLogin(page, "UI V2 integrations");
  await page.goto("/admin/system/integrations");

  const integrationStatus = page.locator(
    'section[aria-labelledby="integration-status-title"]',
  );
  await expect(
    integrationStatus.getByRole("heading", { name: "集成运行状态" }),
  ).toBeVisible();
  await expect(integrationStatus.getByText("未配置", { exact: true })).toHaveCount(1);
  await expect(integrationStatus.getByText("已配置", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("status", { name: "当前没有失败任务" })).toContainText(
    "查看系统健康",
  );
  await expect(page.getByRole("button", { name: "管理飞书" })).toBeVisible();
  await expect(page.getByRole("button", { name: "测试飞书连接" })).toHaveCount(0);
  await page.getByRole("button", { name: "管理飞书" }).click();
  await expect(page.getByRole("dialog", { name: "管理飞书集成" })).toBeVisible();
  await expect(page.getByRole("button", { name: "验证只读连接" })).toBeVisible();
  await page.keyboard.press("Escape");

  await db.insert(integrationOutbox).values({
    aggregateId: "shipment-ui-v2",
    aggregateType: "ORDER_SHIPMENT",
    eventType: "JIFENG_CREATE_ORDER",
    idempotencyKey: `ui-v2-integration-${crypto.randomUUID()}`,
    lastErrorCode: "REMOTE_TIMEOUT",
    payload: {},
    status: "FAILED",
    target: "JIFENG",
  });
  await page.reload();

  await expect(page.getByText("运行降级", { exact: true })).toHaveCount(0);
  await expect(integrationStatus.getByText("已配置", { exact: true })).toBeVisible();
  await expect(page.getByText("极风仓储", { exact: true })).toBeVisible();
  await expect(page.getByText("已有订单匹配", { exact: true })).toBeVisible();
  await expect(page.getByText("执行失败", { exact: true })).toBeVisible();
  await expect(page.getByText("JIFENG", { exact: true })).toHaveCount(0);
  await expect(page.getByText("JIFENG_CREATE_ORDER", { exact: true })).toHaveCount(0);
  await expect(page.getByText("FAILED", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("JIFENG_CLIENT_SECRET");
  await expect(page.locator("body")).not.toContainText("FEISHU_APP_SECRET");
  await expectPageQuality(page);
});

test("health translates checks into read-only operational impact", async ({ page }) => {
  await resetAndLogin(page, "UI V2 health");
  await page.goto("/admin/system/health");

  await expect(page.getByRole("heading", { name: "运营影响与下一步" })).toBeVisible();
  await expect(
    page.getByText("极风订单匹配、状态同步或异常通知可能延迟"),
  ).toBeVisible();
  await expect(page.getByText("客户可能无法看到完整物流进度")).toBeVisible();
  await expect(page.getByRole("status", { name: "所有运营检查正常" })).toContainText(
    "查看审计日志",
  );
  await expect(page.locator("main form")).toHaveCount(0);
  await expect(page.locator("main button")).toHaveCount(0);
  await expect(page.getByText("HEALTHY", { exact: true })).toHaveCount(0);
  await expect(page.getByText("DEGRADED", { exact: true })).toHaveCount(0);
  await expectPageQuality(page);
});

test("audit keeps common filters compact and localizes event labels", async ({ page }) => {
  await resetAndLogin(page, "UI V2 audit");
  await page.goto("/admin/system/audit?action=NO_MATCH");

  await expect(page.getByLabel("操作主体")).toBeVisible();
  await expect(page.getByRole("button", { name: "更多筛选" })).toBeVisible();
  await expect(page.getByLabel("操作事件")).toHaveCount(0);
  await expect(page.getByLabel("业务对象")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "没有符合条件的审计记录" })).toContainText(
    "清除筛选",
  );

  await page.getByRole("button", { name: "更多筛选" }).click();
  const drawer = page.getByRole("dialog", { name: "更多审计筛选" });
  await expect(drawer.getByLabel("操作事件")).toBeVisible();
  await expect(drawer.getByLabel("业务对象")).toBeVisible();
  await page.keyboard.press("Escape");

  await db.insert(auditLogs).values({
    action: "INVENTORY_ADJUSTED",
    actorId: "admin-ui-v2",
    actorType: "ADMIN",
    afterJson: { quantity: 8 },
    beforeJson: { quantity: 5 },
    entityId: "SKU-UI-V2",
    entityType: "SKU_INVENTORY",
    reason: "补充到货库存",
  });
  await page.goto("/admin/system/audit");

  await expect(page.getByRole("cell", { name: "管理员" })).toBeVisible();
  await expect(page.getByText("库存调整", { exact: true })).toBeVisible();
  await expect(page.getByText("SKU 库存 · SKU-UI-V2", { exact: true })).toBeVisible();
  await expect(page.getByText("ADMIN", { exact: true })).toHaveCount(0);
  await expect(page.getByText("INVENTORY_ADJUSTED", { exact: true })).toHaveCount(0);
  await expect(page.getByText("SKU_INVENTORY", { exact: true })).toHaveCount(0);
  await expectPageQuality(page);
});

test("secondary admin pages fit every approved mobile width @mobile-only", async ({ page }) => {
  const browserErrors = observeBrowserErrors(page);
  await resetAndLogin(page, "UI V2 secondary pages mobile matrix");
  const routes = [
    "/admin/replacements",
    "/admin/reports",
    "/admin/notifications",
    "/admin/system/integrations",
    "/admin/system/health",
    "/admin/system/audit",
  ];

  for (const route of routes) {
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ height: width === 360 ? 800 : width === 390 ? 844 : 900, width });
      await page.goto(route);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('[data-metric-strip]')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        `${route} should not overflow at ${width}px`,
      ).toBeLessThanOrEqual(1);

      if (width === 390) {
        const accessibility = await new AxeBuilder({ page }).analyze();
        expect(
          accessibility.violations.filter((violation) =>
            ["serious", "critical"].includes(violation.impact ?? ""),
          ),
          `${route} mobile accessibility`,
        ).toEqual([]);
      }
    }
  }

  expect(browserErrors, "unexpected browser console/page errors").toEqual([]);
});
