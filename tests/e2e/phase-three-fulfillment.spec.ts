import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderLines,
  orderShipments,
  products,
  replacementRequests,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { encryptPii } from "@/shared/pii-crypto";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

async function seedShippedOrder() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const admin = await createManagedUser({ role: "admin" });
  const [adminProfile] = await db
    .insert(adminUsers)
    .values({ displayName: "履约 E2E 管理员", loginIdentifier: admin.email })
    .returning();
  const [customer] = await db
    .insert(customers)
    .values({ code: `FUL-${suffix}`, name: `履约客户 ${suffix}` })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `TEMU 渥太华 ${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `履约商品 ${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 450,
      name: "黑色",
      productId: product.id,
      skuCode: `TZX-FUL-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      orderNumber: `TZX-FUL-${suffix}`,
      paidAt: new Date(),
      paymentMode: "DIRECT_OFFLINE",
      source: "MANUAL",
      status: "SHIPPED",
      storeId: store.id,
      totalAmountFen: 900,
      totalPackageCount: 1,
      totalQuantity: 2,
    })
    .returning();
  const [shipment] = await db
    .insert(orderShipments)
    .values({
      externalOrderNo: `TEMU-${suffix}`,
      logisticsCurrency: "CAD",
      logisticsFeeMinor: 899,
      orderId: order.id,
      recipientPayloadEncrypted: encryptPii({
        addressLine1: "400 Example Street",
        addressLine2: null,
        addressLine3: null,
        alternatePhone: null,
        city: "Ottawa",
        country: "Canada",
        district: null,
        email: null,
        identityNumber: null,
        name: "E2E Recipient",
        phone: "+1 613 555 0120",
        postalCode: "K1A 0B1",
        province: "Ontario",
        taxNumber: null,
      }),
      shippedAt: new Date(),
      storeId: store.id,
      trackingNumber: `CP-${suffix}`,
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
  await db.insert(shipmentFulfillments).values({
    attemptCount: 1,
    erpNo: `ERP-${suffix}`,
    jifengStatus: 7,
    shipmentId: shipment.id,
    shippedAt: new Date(),
    status: "SHIPPED",
  });
  return { admin, adminProfile, order, shipment, sku };
}

test("administrator can inspect a shipped package and create a replacement @desktop-only", async ({
  page,
}) => {
  const fixture = await seedShippedOrder();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/orders/${fixture.order.id}`);

  await expect(page.getByRole("heading", { name: fixture.order.orderNumber })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回订单列表" })).toBeVisible();
  await expect(page.getByText("包裹数", { exact: true })).toHaveCount(1);
  await expect(page.getByText("商品件数", { exact: true })).toHaveCount(1);
  await expect(page.getByText("实际成交额", { exact: true })).toHaveCount(1);
  await expect(page.getByText("创建时间", { exact: true })).toHaveCount(1);
  await expect(page.getByText(`ERP-${fixture.order.orderNumber.slice(-8)}`)).toBeVisible();
  await expect(page.getByText(`CP-${fixture.order.orderNumber.slice(-8)}`)).toBeVisible();
  await expect(page.getByText("CAD 8.99")).toBeVisible();
  await page.getByLabel(`${fixture.sku.skuCode}（原 2 件）`).fill("1");
  await page.getByPlaceholder("填写补发原因，例如：运输破损").fill("E2E 运输破损补发");
  await page.getByText("我确认补发将立即锁定所选库存").click();
  await page.getByRole("button", { name: "创建补发并锁定库存" }).click();
  await expect(page.getByText("补发已创建并锁定库存，等待极风履约。")).toBeVisible();

  await expect.poll(async () => {
    const rows = await db
      .select()
      .from(replacementRequests)
      .where(eq(replacementRequests.orderId, fixture.order.id));
    return rows.length;
  }).toBe(1);
  const reservations = await db
    .select()
    .from(inventoryReservations)
    .where(eq(inventoryReservations.referenceType, "REPLACEMENT_REQUEST"));
  expect(reservations.some((row) => row.skuId === fixture.sku.id && row.quantity === 1)).toBe(true);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});

test("fulfillment detail and integration settings fit approved mobile widths @mobile-only", async ({
  page,
}) => {
  const fixture = await seedShippedOrder();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/admin/orders/${fixture.order.id}`);
    await expect(page.getByRole("heading", { name: fixture.order.orderNumber })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建补发并锁定库存" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }

  await page.goto("/admin/system/integrations");
  await expect(page.getByRole("heading", { name: "外部集成" })).toBeVisible();
  const jifengMetric = page.locator("[data-metric-strip] article").filter({ hasText: "极风连接" });
  const feishuPanel = page
    .locator("section[data-workspace-panel]")
    .filter({ has: page.getByRole("heading", { name: "飞书货盘与机器人" }) });
  await expect(feishuPanel.getByText("未配置", { exact: true })).toHaveCount(1);
  await expect(jifengMetric.getByText("未连接", { exact: true })).toHaveCount(1);
  await expect(jifengMetric.getByText("开发者配置待补齐", { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
