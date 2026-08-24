import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bulkImportStoreGroups,
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
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const VISUAL_REVIEW_DIR = "visual-review/screenshots/fix-round1";

async function expectUsableViewport(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const heights = await page
    .getByRole("button", { name: /提交拿货单/ })
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const styles = window.getComputedStyle(button);
          return styles.display !== "none" && styles.visibility !== "hidden";
        })
        .map((button) => button.getBoundingClientRect().height),
    );
  expect(heights).not.toHaveLength(0);
  expect(heights.every((height) => height >= 44)).toBe(true);
}

async function expectStickySummaryDoesNotObstructContent(
  page: import("@playwright/test").Page,
) {
  const geometry = await page.evaluate(() => {
    const summary = document.querySelector<HTMLElement>("[data-testid='bulk-order-summary']");
    const refresh = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("刷新草稿"),
    );
    if (!summary || !refresh) return null;
    const summaryBox = summary.getBoundingClientRect();
    const refreshBox = refresh.getBoundingClientRect();
    return {
      refreshBottom: refreshBox.bottom,
      scrollHeight: document.documentElement.scrollHeight,
      summaryTop: summaryBox.top,
      viewportHeight: window.innerHeight,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.refreshBottom).toBeLessThanOrEqual(geometry?.summaryTop ?? 0);
  expect(geometry?.scrollHeight).toBeGreaterThan(geometry?.viewportHeight ?? 0);
}

async function expectContinuousSummaryMetrics(
  page: import("@playwright/test").Page,
) {
  const visibleLabels = await page.getByTestId("bulk-order-summary").evaluate((summary) =>
    [...summary.querySelectorAll("dt, p")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.textContent?.trim()),
  );
  for (const label of ["店铺", "订单", "件数", "金额", "不可提交"]) {
    expect(visibleLabels).toContain(label);
  }
}

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
    .values({
      name: `多店铺商品 ${suffix}`,
    })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: 10_000,
      defaultUnitPriceFen: 1_000,
      name: "蓝色",
      productId: product.id,
      skuCode: `BULK-SKU-${suffix}`,
    })
    .returning();

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

  return { customerId: customer.id, customerUser, draftId: draft.id };
}

async function seedSubmittedBulkWorkspace() {
  const fixture = await seedBulkWorkspace();
  const groups = await db
    .select({ id: bulkImportStoreGroups.id })
    .from(bulkImportStoreGroups)
    .where(eq(bulkImportStoreGroups.draftId, fixture.draftId))
    .orderBy(bulkImportStoreGroups.createdAt);

  const submission = await submitBulkDraft({
    actorUserId: fixture.customerUser.userId,
    customerId: fixture.customerId,
    draftId: fixture.draftId,
    idempotencyKey: crypto.randomUUID(),
    requestedWalletFen: 0,
    selectedGroupIds: groups.map((group) => group.id),
  });

  if (!submission.settlementBatchId) {
    throw new Error("Multi-store bulk submission did not create a settlement batch");
  }

  return {
    ...fixture,
    settlementBatchId: submission.settlementBatchId,
  };
}

test("customer submits an eight-store bulk workspace and lands on unified settlement @desktop-only", async ({
  page,
}) => {

  const fixture = await seedBulkWorkspace();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);

  await page.goto("/portal/bulk-orders");
  const nextStep = page.getByRole("region", { name: "多店铺上传下一步" });
  await expect(nextStep.getByRole("link", { name: "继续上次草稿" })).toHaveAttribute(
    "href",
    `/portal/bulk-orders/${fixture.draftId}`,
  );
  await expect(nextStep.getByRole("button", { name: "新建批量草稿" })).toBeVisible();

  await page.goto(`/portal/bulk-orders/${fixture.draftId}`);
  await expect(
    page.getByRole("heading", { name: "多店铺批量上传" }),
  ).toBeVisible();
  await expect(page.getByText("8 个店铺可提交")).toBeVisible();
  await expect(page.getByRole("button", { name: "提交拿货单" }).first()).toBeEnabled();
  await expectUsableViewport(page);

  const summary = page.getByTestId("bulk-order-summary");
  await expect(summary).toBeVisible();
  await expectContinuousSummaryMetrics(page);
  const summaryBox = await summary.boundingBox();
  expect(summaryBox?.height).toBeGreaterThanOrEqual(96);
  expect(summaryBox?.height).toBeLessThanOrEqual(120);
  expect((await page.locator("article").first().boundingBox())?.y).toBeLessThan(500);
  await page.screenshot({
    fullPage: true,
    path: `${VISUAL_REVIEW_DIR}/bulk-workspace-1440.png`,
  });

  await page.getByRole("button", { name: "提交拿货单" }).first().click();

  await expect(page).toHaveURL(/\/portal\/settlements\//, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "本次合并付款" })).toBeVisible();
  await expect(page.getByRole("region", { name: "付款任务" })).toBeVisible();
  await expect(page.getByRole("region", { name: "本次包含的拿货单" })).toBeVisible();
  // 只读付款输入展示当前微信待付，不重复展示已由钱包冻结抵扣的部分。
  await expect(page.getByLabel("付款金额（元）")).toHaveValue("104.00");
  await expect(page.getByRole("heading", { name: "本次合并付款" })).toBeVisible();
  await expect(page.getByRole("link", { name: "跳到付款声明" })).toHaveAttribute(
    "href",
    "#settlement-payment-form",
  );
  await expect(page.locator("#settlement-payment-form")).toHaveAttribute("tabindex", "-1");
  await page.locator("#settlement-payment-form").focus();
  await expect(page.locator("#settlement-payment-form")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "我已微信付款" }),
  ).toBeVisible();
  const settlementPath = new URL(page.url()).pathname;
  await page.screenshot({
    fullPage: true,
    path: `${VISUAL_REVIEW_DIR}/settlement-1440.png`,
  });

  await page.getByRole("link", { name: "返回合并付款记录" }).click();
  await expect(page).toHaveURL(/\/portal\/settlements$/);
  await expect(page.getByRole("heading", { exact: true, name: "合并付款记录" })).toBeVisible();
  await expect(page.getByRole("link", { name: "继续付款" })).toHaveAttribute(
    "href",
    settlementPath,
  );
});

test("customer bulk workspace stays usable at approved mobile widths @mobile-only", async ({
  page,
}) => {

  const fixture = await seedBulkWorkspace();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal/);

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ height: 844, width });
    await page.goto(`/portal/bulk-orders/${fixture.draftId}`);
    await expect(
      page.getByRole("heading", { name: "多店铺批量上传" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "提交拿货单" }).first(),
    ).toBeVisible();
    await expectUsableViewport(page);

    if (width === 360) {
      const firstStore = page.getByRole("checkbox", { name: "选择TEMU 多店铺 1" });
      await firstStore.click();
      await expect(firstStore).toHaveAttribute("data-state", "unchecked");
      await page.reload();
      await expect(
        page.getByRole("checkbox", { name: "选择TEMU 多店铺 1" }),
      ).toHaveAttribute("data-state", "unchecked");
      await page.getByRole("checkbox", { name: "选择TEMU 多店铺 1" }).click();
    }

    const summary = page.getByTestId("bulk-order-summary");
    expect((await summary.boundingBox())?.height).toBeLessThanOrEqual(96);
    await expectContinuousSummaryMetrics(page);
    expect((await page.locator("article").first().boundingBox())?.y).toBeLessThan(600);
    await page.getByRole("button", { name: "刷新草稿" }).scrollIntoViewIfNeeded();
    await expectStickySummaryDoesNotObstructContent(page);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
    await page.screenshot({
      fullPage: true,
      path: `${VISUAL_REVIEW_DIR}/bulk-workspace-${width}.png`,
    });
  }

  expect(consoleErrors).toEqual([]);
});

test("administrator can open unified settlement/bulk diagnostics routes", async ({ page }) => {
  const admin = await createManagedUser({ role: "admin" });
  const fixture = await seedSubmittedBulkWorkspace();
  const consoleErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await loginThroughUi(page, admin);
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto("/admin/settlement");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("region", { name: "待核款队列" })).toBeVisible();
  await expect(page.getByRole("region", { name: "客户余额" })).toBeVisible();
  await expect(page.getByRole("region", { name: "批量付款审核" })).toBeVisible();
  await expect(page.getByRole("region", { name: "资金流水" })).toBeVisible();
  const settlementShortcut = page.locator("main a[href='/admin/settlement-batches']").last();
  await expect(settlementShortcut).toBeVisible();
  await expect(settlementShortcut).toContainText(/\d+/);

  await page.goto("/admin/settlement-batches");
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("region", { name: "批量付款记录" })).toBeVisible();

  await page.goto(`/admin/settlement-batches/${fixture.settlementBatchId}`);
  await expect(page).toHaveURL(
    new RegExp(`/admin/settlement-batches/${fixture.settlementBatchId}`),
  );
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "本次批量付款明细" })).toBeVisible();
  await expect(page.getByRole("region", { name: "付款审核" })).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: `${VISUAL_REVIEW_DIR}/admin-settlement-review-1440.png`,
  });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);

  await page.goto("/admin/bulk-orders");
  await expect(page.locator("main h1")).toBeVisible();
  await page.goto(`/admin/bulk-orders/${fixture.draftId}`);
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Recipient");
  await expect(page.locator("body")).not.toContainText("+1 416 555 0100");

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/admin/settlement-batches/${fixture.settlementBatchId}`);
  await expect(page.getByRole("heading").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const touchHeights = await page
    .locator("button:visible")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(touchHeights).not.toHaveLength(0);
  expect(touchHeights.every((height) => height >= 44)).toBe(true);
  await page.screenshot({
    fullPage: true,
    path: `${VISUAL_REVIEW_DIR}/admin-settlement-review-390.png`,
  });
  expect(consoleErrors).toEqual([]);
});

test("customer cannot access admin settlement and bulk settlement routes", async ({ page }) => {
  const fixture = await seedSubmittedBulkWorkspace();

  await loginThroughUi(page, fixture.customerUser);
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);

  await page.goto("/admin/settlement");
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);

  await page.goto(`/admin/settlement-batches/${fixture.settlementBatchId}`);
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);

  await page.goto("/admin/settlement-batches");
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);

  await page.goto("/admin/bulk-orders");
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);

  await page.goto(`/admin/bulk-orders/${fixture.draftId}`);
  await expect(page).toHaveURL(/\/portal(?:\/|$)/);
});
