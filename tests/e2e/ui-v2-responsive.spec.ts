import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  orderLines,
  products,
  skus,
  stores,
} from "@/db/schema";
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

const approvedViewports = [
  { height: 900, kind: "desktop", width: 1440 },
  { height: 1080, kind: "desktop", width: 1920 },
  { height: 900, kind: "mobile", width: 430 },
  { height: 844, kind: "mobile", width: 390 },
  { height: 800, kind: "mobile", width: 360 },
] as const;

type ApprovedViewport = (typeof approvedViewports)[number];

type Audience = keyof typeof accounts;
type PageType = "business-detail" | "monitoring" | "operations-dashboard" | "resource-list" | "task-flow";
type KeyTarget = {
  name: string | RegExp;
  role: "button" | "link" | "searchbox";
};
type AcceptanceRoute = {
  audience: Audience;
  closedFormButtonNames?: string[];
  heading: string | RegExp;
  keyTarget: KeyTarget;
  pageType: PageType;
  path: string;
};

const navigation = {
  admin: {
    drawerTitle: "管理员导航",
    groups: ["工作台", "客户与货品", "订单履约", "资金与数据", "系统管理"],
    label: "管理员主导航",
  },
  customer: {
    drawerTitle: "客户导航",
    groups: ["工作台", "拿货", "订单与付款"],
    label: "客户主导航",
  },
} as const;

function observeBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const hydrationErrors: string[] = [];
  const pageErrors: string[] = [];

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

async function waitForLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectNoPageOverflow(page: Page, context: string) {
  const result = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - clientWidth;
    const offenders = [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > clientWidth + 1);
      })
      .slice(0, 10)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          ariaLabel: element.getAttribute("aria-label"),
          className: element.className.toString().slice(0, 160),
          rect: { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) },
          tagName: element.tagName,
        };
      });
    return { clientWidth, offenders, overflow };
  });
  expect(
    result.overflow,
    `${context} horizontal overflow; offenders=${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(1);
}

async function expectNoSeriousAccessibilityViolations(page: Page, context: string) {
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
    `${context} serious/critical axe violations`,
  ).toEqual([]);
}

async function expectAtLeast44Pixels(target: Locator, context: string) {
  await expect(target, `${context} should be visible`).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${context} should have a bounding box`).not.toBeNull();
  expect(box!.height, `${context} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${context} width`).toBeGreaterThanOrEqual(44);
}

async function expectShellAndNavigation(
  page: Page,
  audience: Audience,
  viewport: ApprovedViewport,
  context: string,
) {
  const topbar = page.locator("[data-merchant-topbar]");
  const topbarBox = await topbar.boundingBox();
  expect(topbarBox, `${context} topbar should render`).not.toBeNull();
  expect(topbarBox!.x, `${context} topbar x`).toBeCloseTo(0, 1);
  expect(topbarBox!.y, `${context} topbar y`).toBeCloseTo(0, 1);
  expect(topbarBox!.height, `${context} topbar height`).toBeCloseTo(56, 1);
  expect(topbarBox!.width, `${context} topbar width`).toBeCloseTo(viewport.width, 1);

  const nav = navigation[audience];
  if (viewport.kind === "desktop") {
    const brandBox = await page.locator("[data-merchant-brand]").boundingBox();
    const sidebarBox = await page.locator("[data-merchant-sidebar]").boundingBox();
    expect(brandBox, `${context} brand geometry`).toMatchObject({ height: 56, width: 224, x: 0, y: 0 });
    expect(sidebarBox, `${context} sidebar geometry`).toMatchObject({ width: 224, x: 0, y: 56 });

    const desktopNavigation = page.getByRole("navigation", { name: nav.label });
    await expect(desktopNavigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(desktopNavigation.locator("[data-navigation-section]")).toHaveCount(nav.groups.length);
    for (const group of nav.groups) {
      await expect(desktopNavigation.getByRole("button", { name: group })).toBeVisible();
    }
    return;
  }

  const topbarButtons = topbar.getByRole("button");
  for (let index = 0; index < (await topbarButtons.count()); index += 1) {
    await expectAtLeast44Pixels(topbarButtons.nth(index), `${context} topbar button ${index + 1}`);
  }

  const menuButton = page.getByRole("button", { name: "打开导航" });
  await menuButton.click();
  const drawer = page.getByRole("dialog", { name: nav.drawerTitle });
  await expect(drawer).toBeVisible();
  const mobileNavigation = drawer.getByRole("navigation", { name: nav.label });
  await expect(mobileNavigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(mobileNavigation.locator("[data-navigation-section]")).toHaveCount(nav.groups.length);
  for (const group of nav.groups) {
    await expectAtLeast44Pixels(
      mobileNavigation.getByRole("button", { name: group }),
      `${context} navigation group ${group}`,
    );
  }
  await expectNoPageOverflow(page, `${context} with navigation drawer open`);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menuButton).toBeFocused();
}

async function expectNoPermanentRowForms(page: Page, route: AcceptanceRoute) {
  const rowFormSelectors = [
    "[data-account-card] form",
    "[data-customer-table] form",
    "[data-customer-cards] form",
    "[data-admin-catalog-table] form",
    "[data-admin-catalog-cards] form",
    "[data-inventory-table] form",
    "[data-inventory-cards] form",
  ];
  await expect(page.locator(rowFormSelectors.join(","))).toHaveCount(0);

  for (const name of route.closedFormButtonNames ?? []) {
    await expect(page.getByRole("button", { exact: true, name })).toHaveCount(0);
  }
}

async function createBusinessDetailFixture() {
  const [customer] = await db.select().from(customers).where(eq(customers.code, "DEMO-CUSTOMER")).limit(1);
  if (!customer) throw new Error("UI V2 acceptance seed customer is missing");

  const [store] = await db.select().from(stores).where(eq(stores.customerId, customer.id)).limit(1);
  const [sku] = await db.select().from(skus).where(eq(skus.skuCode, "TZX-DEMO-001")).limit(1);
  if (!store || !sku) throw new Error("UI V2 acceptance seed store/SKU is missing");

  const [product] = await db.select().from(products).where(eq(products.id, sku.productId)).limit(1);
  if (!product) throw new Error("UI V2 acceptance seed product is missing");

  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      lockExpiresAt: new Date("2026-08-14T12:00:00.000Z"),
      orderNumber: "UI-V2-ACCEPTANCE-ORDER",
      source: "MANUAL",
      status: "PENDING_PAYMENT",
      storeId: store.id,
      submittedAt: new Date("2026-08-13T12:00:00.000Z"),
      totalAmountFen: 760,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: "TEMU-UI-V2-001",
    externalSubOrderNo: "TEMU-UI-V2-SUB-001",
    lineAmountFen: 760,
    orderId: order.id,
    quantity: 1,
    skuCodeSnapshot: sku.skuCode,
    skuId: sku.id,
    skuNameSnapshot: `${product.name} · ${sku.name}`,
    storeId: store.id,
    unitPriceFen: 760,
  });

  return { customer, order };
}

function acceptanceRoutes(fixture: Awaited<ReturnType<typeof createBusinessDetailFixture>>): AcceptanceRoute[] {
  return [
    {
      audience: "admin",
      heading: "运营总览",
      keyTarget: { name: "审核收款", role: "link" },
      pageType: "operations-dashboard",
      path: "/admin",
    },
    {
      audience: "admin",
      closedFormButtonNames: ["保存资料", "重置密码", "停用账号"],
      heading: "账号管理",
      keyTarget: { name: "新建管理员", role: "button" },
      pageType: "resource-list",
      path: "/admin/accounts",
    },
    {
      audience: "admin",
      heading: "商品与 SKU",
      keyTarget: { name: "搜索商品与 SKU", role: "searchbox" },
      pageType: "resource-list",
      path: "/admin/catalog",
    },
    {
      audience: "admin",
      heading: "货盘库存",
      keyTarget: { name: "搜索库存 SKU", role: "searchbox" },
      pageType: "resource-list",
      path: "/admin/inventory",
    },
    {
      audience: "admin",
      heading: "客户与店铺",
      keyTarget: { name: "新建客户", role: "button" },
      pageType: "resource-list",
      path: "/admin/customers",
    },
    {
      audience: "admin",
      closedFormButtonNames: ["保存客户资料", "保存店铺资料", "停用客户", "停用店铺"],
      heading: fixture.customer.name,
      keyTarget: { name: "编辑客户", role: "button" },
      pageType: "business-detail",
      path: `/admin/customers/${fixture.customer.id}`,
    },
    {
      audience: "admin",
      heading: "经营报表",
      keyTarget: { name: "生成报表", role: "button" },
      pageType: "monitoring",
      path: "/admin/reports",
    },
    {
      audience: "customer",
      heading: "客户首页",
      keyTarget: { name: /货盘选品/, role: "link" },
      pageType: "operations-dashboard",
      path: "/portal",
    },
    {
      audience: "customer",
      heading: "货盘选品",
      keyTarget: { name: "搜索 SKU、商品、规格或链接文字", role: "searchbox" },
      pageType: "resource-list",
      path: "/portal/catalog",
    },
    {
      audience: "customer",
      heading: fixture.order.orderNumber,
      keyTarget: { name: "我已微信付款", role: "button" },
      pageType: "business-detail",
      path: `/portal/orders/${fixture.order.id}`,
    },
    {
      audience: "customer",
      heading: "上传 TEMU 订单",
      keyTarget: { name: "上传并生成预览", role: "button" },
      pageType: "task-flow",
      path: "/portal/imports/new",
    },
    {
      audience: "customer",
      heading: "多店铺批量拿货",
      keyTarget: { name: "新建批量草稿", role: "button" },
      pageType: "task-flow",
      path: "/portal/bulk-orders",
    },
  ];
}

test.describe.configure({ mode: "serial", timeout: 600_000 });

async function runApprovedViewportAcceptance(
  page: Page,
  viewports: readonly ApprovedViewport[],
) {
  const browserErrors = observeBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await resetE2EDatabaseToSeedState({
    context: "UI V2 final responsive acceptance",
    database: db,
    reseed: seed,
  });
  const routes = acceptanceRoutes(await createBusinessDetailFixture());

  expect(new Set(routes.map((route) => route.audience))).toEqual(new Set<Audience>(["admin", "customer"]));
  expect(new Set(routes.map((route) => route.pageType))).toEqual(
    new Set<PageType>([
      "business-detail",
      "monitoring",
      "operations-dashboard",
      "resource-list",
      "task-flow",
    ]),
  );

  for (const audience of ["admin", "customer"] as const) {
    await page.context().clearCookies();
    await loginThroughUi(page, accounts[audience]);
    await expect(page).toHaveURL(audience === "admin" ? /\/admin$/ : /\/portal$/);

    for (const route of routes.filter((candidate) => candidate.audience === audience)) {
      for (const viewport of viewports) {
        const context = `${route.pageType} ${route.path} at ${viewport.width}x${viewport.height}`;
        await test.step(context, async () => {
          await page.setViewportSize({ height: viewport.height, width: viewport.width });
          const response = await page.goto(route.path);
          expect(response?.status(), `${context} document status`).toBeLessThan(400);
          await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
          await expect(page.locator("[data-nextjs-dialog-overlay]")).toHaveCount(0);
          await waitForLayout(page);

          await expectShellAndNavigation(page, audience, viewport, context);
          await expectNoPermanentRowForms(page, route);
          await expectNoPageOverflow(page, context);

          const currentGroup = page.locator(
            `[data-navigation-section][data-current-group="true"]`,
          );
          if (viewport.kind === "desktop") {
            await expect(currentGroup).toHaveCount(1);
            await expect(currentGroup.locator('[aria-current="page"]')).toHaveCount(1);
          }

          if (route.path === "/admin/catalog") {
            if (viewport.kind === "desktop") {
              await expect(page.getByRole("table", { name: "商品与 SKU 列表" })).toBeVisible();
            } else {
              await expect(page.getByRole("list", { name: "商品与 SKU 卡片列表" })).toBeVisible();
            }
          }
          if (route.path === "/admin/accounts") {
            if (viewport.kind === "desktop") {
              await expect(page.getByRole("table", { name: "账号列表" })).toBeVisible();
              const tabs = page.getByRole("tablist");
              const tabOverflow = await tabs.evaluate(
                (element) => element.scrollWidth - element.clientWidth,
              );
              expect(tabOverflow, `${context} desktop tab overflow`).toBeLessThanOrEqual(1);
            } else {
              await expect(page.getByRole("list", { name: "账号摘要卡片" })).toBeVisible();
            }
          }
          if (route.path === "/portal/catalog") {
            if (viewport.kind === "desktop") {
              await expect(page.getByRole("table", { name: "客户货盘列表" })).toBeVisible();
            } else {
              await expect(page.getByRole("list", { name: "客户货盘卡片列表" })).toBeVisible();
            }
          }

          if (viewport.kind === "mobile") {
            const target = page.locator("main").getByRole(route.keyTarget.role, {
              exact: typeof route.keyTarget.name === "string",
              name: route.keyTarget.name,
            }).first();
            await expectAtLeast44Pixels(target, `${context} key target`);
          }

          await expectNoSeriousAccessibilityViolations(page, context);
        });
      }
    }
  }

  expect(browserErrors.consoleErrors, "unexpected console errors").toEqual([]);
  expect(browserErrors.pageErrors, "unexpected page errors").toEqual([]);
  expect(browserErrors.hydrationErrors, "unexpected hydration errors").toEqual([]);
}

test("both audiences and all five page types pass the approved desktop viewport acceptance matrix @desktop-only", async ({ page }) => {
  await runApprovedViewportAcceptance(
    page,
    approvedViewports.filter((viewport) => viewport.kind === "desktop"),
  );
});

test("both audiences and all five page types pass the approved mobile viewport acceptance matrix @mobile-only", async ({ page }) => {
  await runApprovedViewportAcceptance(
    page,
    approvedViewports.filter((viewport) => viewport.kind === "mobile"),
  );
});
