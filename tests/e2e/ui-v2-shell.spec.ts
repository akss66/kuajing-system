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

const navigation = {
  admin: {
    drawerTitle: "管理员导航",
    groups: ["客户与货品", "订单履约", "资金与数据", "系统管理"],
    label: "管理员主导航",
    quickLabel: "管理员快捷导航",
  },
  customer: {
    drawerTitle: "客户导航",
    groups: ["拿货", "履约", "资金"],
    label: "客户主导航",
    quickLabel: "客户快捷导航",
  },
} as const;

const audiences = [
  {
    account: accounts.admin,
    ...navigation.admin,
    genericAccountLabel: "管理员账号",
    sectionCount: 5,
    identity: {
      displayName: "本地演示管理员",
      email: accounts.admin.email,
      role: "超级管理员",
    },
    path: "/admin",
  },
  {
    account: accounts.customer,
    ...navigation.customer,
    genericAccountLabel: "客户账号",
    sectionCount: 4,
    identity: {
      displayName: "渥太华演示客户",
      email: accounts.customer.email,
      role: "合作客户",
    },
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
    const desktopNavigation = page.getByRole("navigation", { name: audience.label });
    await expect(page.getByRole("button", { name: "帮助" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "消息" })).toHaveCount(0);
    const initialAccountTrigger =
      audience.path === "/portal" && (page.viewportSize()?.width ?? 1440) >= 1024
        ? "打开侧栏账号菜单"
        : "打开账号菜单";
    await page.getByRole("button", { name: initialAccountTrigger }).click();
    const accountMenu = page.locator("[data-slot='dropdown-menu-content']");
    await expect(accountMenu).toBeVisible();
    await expect(accountMenu.getByText(audience.identity.displayName, { exact: true })).toBeVisible();
    await expect(accountMenu.getByText(audience.identity.email, { exact: true })).toBeVisible();
    await expect(accountMenu.getByText(audience.identity.role, { exact: true })).toBeVisible();
    await expect(accountMenu.getByText(audience.genericAccountLabel, { exact: true })).toHaveCount(0);
    const signOutButton = accountMenu.getByRole("menuitem", { name: "退出登录" });
    await expect(signOutButton).toBeVisible();
    if ((page.viewportSize()?.width ?? 1440) < 640) {
      const signOutBox = await signOutButton.boundingBox();
      expect(signOutBox).not.toBeNull();
      expect(signOutBox!.height).toBeGreaterThanOrEqual(44);
      await expectNoPageOverflow(page);
      await expectNoSeriousAccessibilityViolations(page);
    }
    await page.keyboard.press("Escape");
    await expect(accountMenu).toBeHidden();

    for (const viewport of viewports) {
      await test.step(`${viewport.width}px ${viewport.kind} shell`, async () => {
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        await waitForResponsiveLayout(page);

        if (viewport.kind === "desktop") {
          await expect(page.getByRole("navigation", { name: audience.quickLabel })).toBeHidden();
          const topbar = await page.locator("[data-merchant-topbar]").boundingBox();
          const brand = await page.locator("[data-merchant-brand]:visible").boundingBox();
          const sidebar = await page.locator("[data-merchant-sidebar]").boundingBox();
          if (audience.path === "/portal") {
            expect(topbar).toBeNull();
            expect(brand).toMatchObject({ x: 0, y: 8, width: 255, height: 80 });
            expect(sidebar).toMatchObject({ x: 0, y: 0, width: 256 });
          } else {
            expect(topbar).toMatchObject({ x: 0, y: 0, height: 56 });
            expect(brand).toMatchObject({ x: 0, y: 0, width: 224, height: 56 });
            expect(sidebar).toMatchObject({ x: 0, y: 56, width: 224 });
          }
          await expect(page.locator("[data-merchant-brand]:visible")).toHaveCSS("border-right-width", "0px");
          await expect(page.locator("[data-merchant-sidebar]")).toHaveCSS("border-right-width", "1px");

          const brandRight = brand!.x + brand!.width;
          const sidebarRight = sidebar!.x + sidebar!.width;
          expect(brandRight).toBe(audience.path === "/portal" ? 255 : 224);
          expect(sidebarRight).toBe(audience.path === "/portal" ? 256 : 224);
          await expect(desktopNavigation.locator('[aria-current="page"]')).toHaveCount(1);
          await expect(desktopNavigation.locator("[data-navigation-section]")).toHaveCount(
            audience.sectionCount,
          );
          for (const group of audience.groups) {
            await expect(desktopNavigation.getByRole("heading", { level: 2, name: group })).toBeVisible();
            await expect(desktopNavigation.getByRole("button", { name: group })).toHaveCount(0);
          }
          await expect(desktopNavigation.locator("[aria-expanded]")).toHaveCount(0);
        } else {
          const quickNavigation = page.getByRole("navigation", { name: audience.quickLabel });
          await expect(quickNavigation).toBeVisible();
          await expect(quickNavigation.getByRole("link")).toHaveCount(4);
          const quickNavigationBox = await quickNavigation.boundingBox();
          expect(quickNavigationBox).not.toBeNull();
          expect(quickNavigationBox!.y + quickNavigationBox!.height).toBeGreaterThanOrEqual(
            viewport.height - 1,
          );
          const menuButton = page.getByRole("button", { name: "打开导航" });
          await menuButton.click();

          const drawer = page.getByRole("dialog", { name: audience.drawerTitle });
          await expect(drawer).toBeVisible();
          const mobileNavigation = drawer.getByRole("navigation", {
            name: audience.label,
          });
          await expect(mobileNavigation.locator('[aria-current="page"]')).toHaveCount(1);
          await expect(mobileNavigation.locator("[data-navigation-section]")).toHaveCount(
            audience.sectionCount,
          );
          for (const group of audience.groups) {
            await expect(mobileNavigation.getByRole("heading", { level: 2, name: group })).toBeVisible();
            await expect(mobileNavigation.getByRole("button", { name: group })).toHaveCount(0);
          }
          await expect(mobileNavigation.locator("[aria-expanded]")).toHaveCount(0);
          const mobileLinks = mobileNavigation.getByRole("link");
          expect(await mobileLinks.count()).toBeGreaterThan(1);
          for (const link of [mobileLinks.first(), mobileLinks.last()]) {
            const box = await link.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
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
