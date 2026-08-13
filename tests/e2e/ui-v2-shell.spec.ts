import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { db } from "@/db/client";
import { seed } from "@/db/seed";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const accounts = {
  admin: {
    email: "admin@tongzhouxing.local",
    password: "TongZhouXing-Admin-2026!",
  },
  customer: {
    email: "customer@tongzhouxing.local",
    password: "TongZhouXing-Customer-2026!",
  },
} as const;

const audiences = [
  {
    account: accounts.admin,
    drawerTitle: "管理员导航",
    groups: ["工作台", "客户与货品", "订单履约", "资金与数据", "系统管理"],
    navigationName: "管理员主导航",
    path: "/admin",
  },
  {
    account: accounts.customer,
    drawerTitle: "客户导航",
    groups: ["工作台", "拿货", "订单与付款"],
    navigationName: "客户主导航",
    path: "/portal",
  },
] as const;

const viewports = [
  { height: 900, kind: "desktop", width: 1440 },
  { height: 1080, kind: "desktop", width: 1920 },
  { height: 932, kind: "mobile", width: 430 },
  { height: 844, kind: "mobile", width: 390 },
  { height: 800, kind: "mobile", width: 360 },
] as const;

function observeBrowserErrors(page: Page) {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  return errors;
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function waitForResponsiveLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.describe.configure({ mode: "serial" });

for (const audience of audiences) {
  test(`${audience.path} uses the V2 shell geometry, grouped navigation and accessible mobile drawer`, async ({
    page,
  }) => {
    const browserErrors = observeBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await resetE2EDatabaseToSeedState({
      context: `UI V2 shell ${audience.path}`,
      database: db,
      reseed: seed,
    });
    await loginThroughUi(page, audience.account);
    await expect(page).toHaveURL(new RegExp(`${audience.path}$`));

    const shell = page.getByTestId("merchant-shell");
    await expect(shell).toHaveAttribute("data-shell-version", "v2");
    const desktopNavigation = page.getByRole("navigation", { name: audience.navigationName });
    await expect(page.getByRole("button", { name: "帮助" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "消息" })).toHaveCount(0);

    for (const viewport of viewports) {
      await test.step(`${viewport.width}px ${viewport.kind} shell`, async () => {
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        await waitForResponsiveLayout(page);

        if (viewport.kind === "desktop") {
          const topbar = await page.locator("[data-merchant-topbar]").boundingBox();
          const brand = await page.locator("[data-merchant-brand]").boundingBox();
          const sidebar = await page.locator("[data-merchant-sidebar]").boundingBox();
          expect(topbar).toMatchObject({ x: 0, y: 0, height: 56 });
          expect(brand).toMatchObject({ x: 0, y: 0, width: 224, height: 56 });
          expect(sidebar).toMatchObject({ x: 0, y: 56, width: 224 });
          await expect(desktopNavigation.locator('[aria-current="page"]')).toHaveCount(1);
          await expect(desktopNavigation.locator("[data-navigation-section]")).toHaveCount(
            audience.groups.length,
          );
          for (const group of audience.groups) {
            await expect(desktopNavigation.getByRole("button", { name: group })).toBeVisible();
          }
        } else {
          const menuButton = page.getByRole("button", { name: "打开导航" });
          await menuButton.click();

          const drawer = page.getByRole("dialog", { name: audience.drawerTitle });
          await expect(drawer).toBeVisible();
          const mobileNavigation = drawer.getByRole("navigation", {
            name: audience.navigationName,
          });
          await expect(mobileNavigation.locator('[aria-current="page"]')).toHaveCount(1);
          await expectNoPageOverflow(page);
          await expectNoSeriousAccessibilityViolations(page);

          await page.keyboard.press("Escape");
          await expect(drawer).toBeHidden();
          await expect(menuButton).toBeFocused();
        }

        await expectNoPageOverflow(page);
        await expectNoSeriousAccessibilityViolations(page);
      });
    }

    expect(browserErrors, "unexpected browser console/page errors").toEqual([]);
  });
}
