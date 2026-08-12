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
  return { admin, sku, store };
}

test("administrator can read the shipped SKU and store report @desktop-only", async ({ page }) => {
  const fixture = await seedReportFixture();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/reports");

  await expect(page.getByRole("heading", { name: "经营报表" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "货盘库存" })).toBeVisible();
  await expect(page.getByText("可售天数")).toBeVisible();
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
