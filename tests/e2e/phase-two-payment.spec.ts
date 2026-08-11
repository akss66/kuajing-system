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
  paymentClaims,
  products,
  skus,
  stores,
} from "@/db/schema";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

async function seedPendingPaymentOrder() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const [customer] = await db
    .insert(customers)
    .values({ code: `PAY-${suffix}`, name: `核款客户 ${suffix}` })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `TEMU 核款店铺 ${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `核款测试商品 ${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 500,
      name: "红色",
      productId: product.id,
      skuCode: `TZX-PAY-${suffix}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: 10,
  });

  const lockExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: customer.id,
      lockExpiresAt,
      orderNumber: `TZX-PAY-${suffix}`,
      source: "MANUAL",
      status: "PENDING_PAYMENT",
      storeId: store.id,
      totalAmountFen: 500,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  await db.insert(orderLines).values({
    lineAmountFen: 500,
    orderId: order.id,
    quantity: 1,
    skuCodeSnapshot: sku.skuCode,
    skuId: sku.id,
    skuNameSnapshot: `${product.name} · ${sku.name}`,
    storeId: store.id,
    unitPriceFen: 500,
  });
  await db.insert(inventoryReservations).values({
    expiresAt: lockExpiresAt,
    quantity: 1,
    referenceId: order.id,
    referenceType: "FULFILLMENT_ORDER",
    skuId: sku.id,
  });

  const customerUser = await createManagedUser({
    customerId: customer.id,
    role: "user",
  });
  const admin = await createManagedUser({ role: "admin" });
  await db.insert(adminUsers).values({
    displayName: "E2E 超级管理员",
    loginIdentifier: admin.email,
  });

  return { admin, customerUser, order };
}

test("customer declares an exact WeChat payment and admin confirms it without using wallet", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The state-changing acceptance flow runs once on desktop",
  );
  const fixture = await seedPendingPaymentOrder();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);
  await page.goto(`/portal/orders/${fixture.order.id}`);
  await expect(
    page.getByRole("heading", { name: fixture.order.orderNumber }),
  ).toBeVisible();
  await expect(page.getByLabel("付款金额（元）")).toHaveValue("5.00");
  await page.getByLabel("付款备注（选填）").fill("微信转账 E2E");
  await page.getByRole("button", { name: "我已微信付款" }).click();
  await expect(
    page.getByRole("heading", { name: "已声明微信付款，等待管理员核款" }),
  ).toBeVisible();
  await expect.poll(async () => {
    const [claim] = await db
      .select({ status: paymentClaims.status })
      .from(paymentClaims)
      .where(eq(paymentClaims.orderId, fixture.order.id));
    return claim?.status;
  }).toBe("PENDING");

  await page.context().clearCookies();
  await loginThroughUi(page, fixture.admin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/orders?orderNumber=${fixture.order.orderNumber}`);
  await expect(
    page.getByRole("heading", { name: "订单管理" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: fixture.order.orderNumber }),
  ).toBeVisible();
  await page.goto("/admin/settlement");
  const claimCard = page.locator("article").filter({
    hasText: fixture.order.orderNumber,
  });
  await expect(claimCard).toContainText("¥5.00");
  await claimCard.getByRole("button", { name: "确认已收款" }).click();
  await expect(
    page.getByRole("heading", { name: "确认这笔微信付款已到账？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认到账" }).click();
  await expect.poll(async () => {
    const [order] = await db
      .select({ paymentMode: fulfillmentOrders.paymentMode, status: fulfillmentOrders.status })
      .from(fulfillmentOrders)
      .where(eq(fulfillmentOrders.id, fixture.order.id));
    return order;
  }).toEqual({
    paymentMode: "DIRECT_OFFLINE",
    status: "PAID_PENDING_FULFILLMENT",
  });

  await page.context().clearCookies();
  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);
  await page.goto(`/portal/orders/${fixture.order.id}`);
  await expect(
    page.getByRole("heading", { name: "付款已完成，等待同舟行发货" }),
  ).toBeVisible();
});

test("customer order payment controls remain usable at approved mobile widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Mobile acceptance runs only in the mobile project",
  );
  const fixture = await seedPendingPaymentOrder();
  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto(`/portal/orders/${fixture.order.id}`);
    await expect(
      page.getByRole("heading", { name: fixture.order.orderNumber }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "我已微信付款" }),
    ).toBeVisible();
    if (width === 360) {
      await page.getByLabel("取消原因").fill("仅验证取消确认，不提交");
      await page.getByRole("button", { name: "确认取消" }).click();
      await expect(
        page.getByRole("heading", { name: "确定取消这张拿货单？" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "返回检查" }).click();
    }
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
