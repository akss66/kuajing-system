import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  customers,
  orderImportBatches,
  orderImportRows,
  skus,
  stores,
} from "@/db/schema";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const customerAccount = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

async function seedBundlePreview() {
  await resetE2EDatabaseToSeedState({
    context: "bundled order import E2E reset",
    database: db,
    reseed: seed,
  });
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.code, "DEMO-CUSTOMER"));
  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.customerId, customer.id));
  const [sku] = await db
    .select({ skuCode: skus.skuCode })
    .from(skus)
    .where(eq(skus.skuCode, "TZX-DEMO-001"));
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: customer.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      fileSizeBytes: 1,
      originalFileName: "bundle-preview.xlsx",
      readyRows: 1,
      storeId: store.id,
      totalRows: 1,
    })
    .returning({ id: orderImportBatches.id });
  await db.insert(orderImportRows).values({
    batchId: batch.id,
    effectiveQuantity: 1,
    externalOrderNo: "PO-BUNDLE-E2E",
    externalSku: "SELLER-BUNDLE-ORIGINAL",
    externalSubOrderNo: "SUB-BUNDLE-E2E",
    finalSkuCode: "SELLER-BUNDLE-ORIGINAL",
    fulfillmentMode: "CUSTOMER_SUPPLIED",
    quantity: 1,
    resolutionMethod: "CUSTOMER_SUPPLIED",
    rowNumber: 2,
    status: "READY",
  });
  return { batchId: batch.id, systemSkuCode: sku.skuCode };
}

test("customer adds TZX and non-TZX items to one uploaded row on mobile", async ({
  page,
}) => {
  const fixture = await seedBundlePreview();
  await loginThroughUi(page, customerAccount);
  await page.goto(`/portal/imports/${fixture.batchId}`);

  await expect(page.getByText("SELLER-BUNDLE-ORIGINAL", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "修改 Excel 第 2 行" }).click();
  await expect(page.getByLabel("手动填写最终 SKU")).toHaveValue(
    "SELLER-BUNDLE-ORIGINAL",
  );

  await page.getByRole("button", { name: "加一个货" }).click();
  await page.getByLabel("新增货品 SKU").fill("  CUSTOM-BUNDLE-ITEM  ");
  await page.getByLabel("新增货品数量").fill("3");
  await page.getByRole("button", { name: "保存新增货品" }).click();
  await expect(page.getByText(/2\. CUSTOM-BUNDLE-ITEM/)).toBeVisible();

  await page.getByRole("button", { name: "修改 Excel 第 2 行" }).click();
  await page.getByRole("button", { name: "加一个货" }).click();
  await page.getByLabel("新增货品 SKU").fill(fixture.systemSkuCode);
  await page.getByLabel("新增货品数量").fill("2");
  await page.getByRole("button", { name: "保存新增货品" }).click();
  await expect(page.getByText(new RegExp(`3\\. ${fixture.systemSkuCode}`))).toBeVisible();
  await expect(page.getByText("实际发货货品（3）")).toBeVisible();

  for (const viewport of [
    { height: 800, width: 360 },
    { height: 844, width: 390 },
    { height: 900, width: 430 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }

  const accessibility = await new AxeBuilder({ page })
    .exclude("nextjs-portal")
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
