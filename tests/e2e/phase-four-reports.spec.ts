import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  orderLines,
  orderShipments,
  products,
  skus,
  stores,
} from "@/db/schema";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

async function seedReportFixture() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const admin = await createManagedUser({ role: "admin" });
  await db.insert(adminUsers).values({
    displayName: "报表 E2E 管理员",
    loginIdentifier: admin.email,
  });
  const [customer] = await db
    .insert(customers)
    .values({ code: `REPORT-${suffix}`, name: `报表客户 ${suffix}` })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `报表店铺 ${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `报表商品 ${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 450,
      name: "青色",
      productId: product.id,
      skuCode: `TZX-REPORT-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 25 });
  const now = new Date();
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-REPORT-${suffix}`,
      paidAt: now,
      paymentMode: "DIRECT_OFFLINE",
      status: "SHIPPED",
      storeId: store.id,
      submittedAt: now,
      totalAmountFen: 900,
      totalPackageCount: 1,
      totalQuantity: 2,
    })
    .returning();
  const [shipment] = await db
    .insert(orderShipments)
    .values({
      externalOrderNo: `REPORT-EXT-${suffix}`,
      orderId: order.id,
      recipientPayloadEncrypted: "encrypted",
      shippedAt: now,
      storeId: store.id,
    })
    .returning();
  await db.insert(orderLines).values({
    lineAmountFen: 900,
    orderId: order.id,
    quantity: 2,
    shipmentId: shipment.id,
    skuCodeSnapshot: sku.skuCode,
    skuId: sku.id,
    skuNameSnapshot: `${product.name} · ${sku.name}`,
    storeId: store.id,
    unitPriceFen: 450,
  });
  return { admin, customer, sku, store };
}

test("administrator can read the shipped SKU and store report @desktop-only", async ({ page }) => {
  const fixture = await seedReportFixture();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/reports");

  await expect(page.getByRole("heading", { name: "经营报表" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "近 7 天经营趋势" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SKU 出库排名" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "库存覆盖风险" })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator('[data-metric-strip]')).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "管理员主导航" }).locator('[aria-current="page"]'),
  ).toHaveCount(1);
  await expect(page.getByText(fixture.sku.skuCode)).toBeVisible();
  await expect(page.getByText(fixture.store.name)).toBeVisible();
  await expect(page.getByText("¥9.00").first()).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});

test("an empty report range explains how to recover @desktop-only", async ({ page }) => {
  const fixture = await seedReportFixture();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/reports?from=2099-01-01&to=2099-01-07");

  const emptyState = page.getByRole("status", { name: "所选区间暂无经营数据" });
  await expect(emptyState).toBeVisible();
  await expect(emptyState.getByRole("link", { name: "查看最近 7 天" })).toBeVisible();
});

test("a funds-only range does not claim there is no operating data @desktop-only", async ({
  page,
}) => {
  const fixture = await seedReportFixture();
  const dayOffset = Number.parseInt(crypto.randomUUID().slice(0, 8), 16) % (365 * 50);
  const submittedAt = new Date(Date.UTC(2100, 0, 1 + dayOffset, 15));
  const reportDate = submittedAt.toISOString().slice(0, 10);
  await db.insert(fulfillmentOrders).values({
    customerId: fixture.customer.id,
    orderNumber: `REPORT-PENDING-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    status: "PENDING_PAYMENT",
    storeId: fixture.store.id,
    submittedAt,
    totalAmountFen: 1_200,
    totalPackageCount: 1,
    totalQuantity: 2,
  });
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/reports?from=${reportDate}&to=${reportDate}`);

  await expect(page.getByText("¥12.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "所选区间暂无经营数据" })).toHaveCount(0);
});

test("reports and stock coverage fit approved mobile widths @mobile-only", async ({ page }) => {
  const fixture = await seedReportFixture();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { name: "经营报表" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }

  await page.goto("/admin/inventory");
  await expect(page.getByRole("heading", { name: "实时库存" })).toBeVisible();
  await expect(page.getByText(/预计可售|暂无消耗基线/).first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test("public health is minimal and administrator health details are protected @desktop-only", async ({
  page,
  request,
}) => {
  const publicHealth = await request.get("/api/health");
  expect(publicHealth.status()).toBe(200);
  expect(await publicHealth.json()).toEqual({ status: "ok" });

  const fixture = await seedReportFixture();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  const response = await page.goto("/admin/system/health");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByRole("heading", { name: "系统健康" })).toBeVisible();
  await expect(page.getByText("只读运营检查")).toBeVisible();
});
