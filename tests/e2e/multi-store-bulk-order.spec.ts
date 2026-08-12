import crypto from "node:crypto";

import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import {
  customerSkuPrices,
  customers,
  inventoryBalances,
  products,
  skuAliases,
  skus,
  stores,
  walletAccounts,
} from "@/db/schema";
import {
  addStoreGroup,
  createBulkDraft,
  uploadGroupFiles,
} from "@/modules/bulk-order/draft-service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function workbookBuffer(index: number) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");

  worksheet.addRow([...TEMU_EXPORT_HEADERS]);
  worksheet.addRow([
    `PO-BULK-${index}`,
    "加拿大",
    "待发货",
    `SUB-BULK-${index}`,
    1,
    `多店铺批量商品 ${index}`,
    `SKUID-${index}`,
    `SKCID-${index}`,
    `SPUID-${index}`,
    `BULK-SKU-${index}`,
    "蓝色",
    `Recipient ${index}`,
    "+1 416 555 0100",
    "",
    `bulk-${index}@example.test`,
    "",
    "",
    `${index} Private Avenue`,
    "",
    "",
    "Toronto",
    "Toronto",
    "Ontario",
    "M5V 3A8",
    "Canada",
    "",
    "",
    "",
    "2026-08-12 10:00:00",
    "2026-08-14 10:00:00",
    "",
    "",
    "",
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function seedBulkWorkspace() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const [customer] = await db
    .insert(customers)
    .values({ code: `BULK-${suffix}`, name: `多店铺客户 ${suffix}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `多店铺商品 ${suffix}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 1_000,
      name: "蓝色",
      productId: product.id,
      skuCode: `BULK-SKU-${suffix}`,
    })
    .returning();

  await db.insert(customerSkuPrices).values({
    customerId: customer.id,
    skuId: sku.id,
    unitPriceFen: 1_000,
  });
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: 100,
  });
  await db.insert(walletAccounts).values({
    balanceFen: 10_000,
    customerId: customer.id,
  });

  const createdStores = await db
    .insert(stores)
    .values(
      Array.from({ length: 8 }, (_, index) => ({
        customerId: customer.id,
        name: `TEMU 多店铺 ${index + 1}`,
      })),
    )
    .returning();

  await db.insert(skuAliases).values(
    createdStores.map((store, index) => ({
      externalSku: `BULK-SKU-${index + 1}`,
      skuId: sku.id,
      storeId: store.id,
    })),
  );

  const customerUser = await createManagedUser({
    customerId: customer.id,
    role: "user",
  });
  const draft = await createBulkDraft({
    actorUserId: customerUser.userId,
    customerId: customer.id,
  });

  for (const [index, store] of createdStores.entries()) {
    const group = await addStoreGroup({
      customerId: customer.id,
      draftId: draft.id,
      storeId: store.id,
    });
    await uploadGroupFiles({
      actorUserId: customerUser.userId,
      customerId: customer.id,
      files: [
        {
          buffer: await workbookBuffer(index + 1),
          fileName: `bulk-${index + 1}.xlsx`,
          mimeType: XLSX_MIME,
        },
      ],
      groupId: group.id,
    });
  }

  return { customerUser, draftId: draft.id };
}

test("customer submits an eight-store bulk workspace and lands on unified settlement", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The state-changing bulk submission flow runs once on desktop",
  );

  const fixture = await seedBulkWorkspace();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);

  await page.goto(`/portal/bulk-orders/${fixture.draftId}`);
  await expect(
    page.getByRole("heading", { name: "多店铺批量拿货" }),
  ).toBeVisible();
  await expect(page.getByText("8 个店铺可提交")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交 8 个店铺" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "提交 8 个店铺" }).click();

  await expect(page).toHaveURL(/\/portal\/settlements\//);
  await expect(page.getByRole("heading", { name: "统一付款" })).toBeVisible();
  await expect(page.getByLabel("付款金额（元）")).toHaveValue("80.00");
  await expect(
    page.getByRole("button", { name: "我已微信付款" }),
  ).toBeVisible();
});

test("customer bulk workspace stays usable at approved mobile widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Mobile acceptance runs only in the mobile project",
  );

  const fixture = await seedBulkWorkspace();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto(`/portal/bulk-orders/${fixture.draftId}`);
    await expect(
      page.getByRole("heading", { name: "多店铺批量拿货" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "提交 8 个店铺" }),
    ).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
