import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  aiSkuMatchRuns,
  aiSkuMatchSuggestions,
  authUsers,
  customers,
  inventoryBalances,
  orderImportBatches,
  orderImportRows,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
};
const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

async function seedAiSkuReviewFixture(options: { enabled?: boolean } = {}) {
  await resetE2EDatabaseToSeedState({
    context: "AI SKU matching E2E reset",
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
  const [customerUser] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, seededCustomer.email));
  if (!customer || !store || !customerUser) {
    throw new Error("AI SKU matching E2E seed is incomplete");
  }
  await db
    .update(customers)
    .set({ aiSkuMatchEnabled: options.enabled ?? false })
    .where(eq(customers.id, customer.id));

  const [product] = await db
    .insert(products)
    .values({ name: "反光宠物牵引绳" })
    .returning();
  const [acceptedSku, staleSku, rejectedSku] = await db
    .insert(skus)
    .values([
      {
        cargoUnitPriceMilliYuan: 8_000,
        color: "红色",
        name: "红色款",
        productId: product.id,
        skuCode: "TZX-AI-RED-150X80",
        specification: "150×80",
      },
      {
        cargoUnitPriceMilliYuan: 8_000,
        color: "黑色",
        name: "黑色款",
        productId: product.id,
        skuCode: "TZX-AI-BLACK-NOW-SOLD-OUT-WITH-A-VERY-LONG-SKU-CODE",
        specification: "150×80",
      },
      {
        cargoUnitPriceMilliYuan: 9_500,
        color: "蓝色",
        name: "蓝色加固款",
        productId: product.id,
        skuCode: "TZX-AI-BLUE-HEAVY",
        specification: "200×100",
      },
    ])
    .returning();
  await db.insert(inventoryBalances).values([
    { skuId: acceptedSku.id, totalQuantity: 8 },
    { skuId: staleSku.id, totalQuantity: 0 },
    { skuId: rejectedSku.id, totalQuantity: 6 },
  ]);

  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: customer.id,
      expiresAt: new Date("2099-01-30T12:00:00.000Z"),
      fileSha256: "a".repeat(64),
      fileSizeBytes: 2_048,
      originalFileName: "ai-sku-review.xlsx",
      storeId: store.id,
      totalRows: 2,
      unknownSkuRows: 2,
    })
    .returning();
  const [acceptedRow, rejectedRow] = await db
    .insert(orderImportRows)
    .values([
      {
        batchId: batch.id,
        effectiveQuantity: 2,
        externalOrderNo: "AI-E2E-ORDER-1",
        externalSku: "UNKNOWN-RED-150-80",
        externalSubOrderNo: "AI-E2E-SUB-1",
        productAttributes: "颜色：红色；尺寸：150*80",
        productName: "反光宠物牵引绳",
        quantity: 2,
        rowNumber: 2,
        status: "UNKNOWN_SKU",
      },
      {
        batchId: batch.id,
        effectiveQuantity: 1,
        externalOrderNo: "AI-E2E-ORDER-2",
        externalSku: "UNKNOWN-BLUE-200-100",
        externalSubOrderNo: "AI-E2E-SUB-2",
        productAttributes: "颜色：蓝色；尺寸：200*100",
        productName: "加固宠物牵引绳",
        quantity: 1,
        rowNumber: 3,
        status: "UNKNOWN_SKU",
      },
    ])
    .returning();
  const [run] = await db
    .insert(aiSkuMatchRuns)
    .values({
      actorUserId: customerUser.id,
      batchId: batch.id,
      completedAt: new Date("2026-08-28T06:00:00.000Z"),
      customerId: customer.id,
      expiresAt: new Date("2099-02-28T12:00:00.000Z"),
      model: "deepseek-v4-flash",
      promptVersion: "v1",
      rowCount: 2,
      status: "SUCCEEDED",
      suggestionCount: 3,
    })
    .returning();
  const [acceptedSuggestion, rejectedSuggestion] = await db
    .insert(aiSkuMatchSuggestions)
    .values([
      {
        batchId: batch.id,
        candidates: [
          {
            confidence: "HIGH" as const,
            rank: 1,
            reason: "商品、颜色和规格一致",
            skuId: acceptedSku.id,
          },
          {
            confidence: "LOW" as const,
            rank: 2,
            reason: "商品名称相近，但库存已变化",
            skuId: staleSku.id,
          },
        ],
        customerId: customer.id,
        expiresAt: new Date("2099-01-30T12:00:00.000Z"),
        inputFingerprint: "b".repeat(64),
        promptVersion: "v1",
        rowId: acceptedRow.id,
        rowRevision: 0,
        runId: run.id,
      },
      {
        batchId: batch.id,
        candidates: [
          {
            confidence: "MEDIUM" as const,
            rank: 1,
            reason: "颜色和尺寸接近，需客户确认",
            skuId: rejectedSku.id,
          },
        ],
        customerId: customer.id,
        expiresAt: new Date("2099-01-30T12:00:00.000Z"),
        inputFingerprint: "c".repeat(64),
        promptVersion: "v1",
        rowId: rejectedRow.id,
        rowRevision: 0,
        runId: run.id,
      },
    ])
    .returning();

  return {
    acceptedRow,
    acceptedSku,
    acceptedSuggestion,
    batch,
    customer,
    rejectedRow,
    rejectedSuggestion,
  };
}

test("super admin authorizes a customer who confirms and rejects AI SKU suggestions", async ({
  page,
}) => {
  const fixture = await seedAiSkuReviewFixture();
  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/accounts");
  await page.getByRole("tab", { name: "客户账号 1" }).click();
  await page
    .getByRole("button", { name: "查看 渥太华演示客户" })
    .click();
  const accountDialog = page.getByRole("dialog", { name: "渥太华演示客户" });
  const aiAccess = accountDialog.getByRole("region", { name: "智能核单试用" });
  await aiAccess.getByLabel("操作原因").fill("E2E 首批试用授权");
  await aiAccess.getByRole("button", { name: "开放智能核单" }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "开放智能核单" }).click();
  await expect
    .poll(async () => {
      const [current] = await db
        .select({ enabled: customers.aiSkuMatchEnabled })
        .from(customers)
        .where(eq(customers.id, fixture.customer.id));
      return current?.enabled;
    })
    .toBe(true);

  await page.context().clearCookies();
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
  await page.goto(`/portal/imports/${fixture.batch.id}`);
  await expect(
    page.getByText(
      "仅发送商品名称、规格和 SKU 信息至 DeepSeek，不发送收件人、地址、联系方式或订单标识。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "智能推荐待匹配 SKU" }),
  ).toBeVisible();

  const acceptedRow = page.getByRole("listitem", { name: "Excel 第 2 行" });
  await acceptedRow
    .getByRole("button", { name: "使用 TZX-AI-RED-150X80" })
    .click();
  await expect(acceptedRow.getByLabel("手动填写最终 SKU")).toHaveValue(
    "TZX-AI-RED-150X80",
  );
  await acceptedRow.getByRole("button", { name: "保存并校验" }).click();
  await expect(acceptedRow.getByText("校验通过", { exact: true })).toBeVisible();
  await expect(acceptedRow.getByText(/已确认智能建议 TZX-AI-RED-150X80/)).toBeVisible();

  const rejectedRow = page.getByRole("listitem", { name: "Excel 第 3 行" });
  await rejectedRow.getByRole("button", { name: "这些都不合适" }).click();
  await expect
    .poll(async () => {
      const suggestions = await db
        .select({ decision: aiSkuMatchSuggestions.decision })
        .from(aiSkuMatchSuggestions)
        .where(
          inArray(aiSkuMatchSuggestions.id, [
            fixture.acceptedSuggestion.id,
            fixture.rejectedSuggestion.id,
          ]),
        );
      return suggestions.map((item) => item.decision).sort();
    })
    .toEqual(["ACCEPTED", "REJECTED"]);

  const [savedAcceptedRow, savedRejectedRow] = await db
    .select({
      id: orderImportRows.id,
      resolutionMethod: orderImportRows.resolutionMethod,
      resolvedSkuId: orderImportRows.resolvedSkuId,
      status: orderImportRows.status,
    })
    .from(orderImportRows)
    .where(
      inArray(orderImportRows.id, [fixture.acceptedRow.id, fixture.rejectedRow.id]),
    )
    .then((rows) => [
      rows.find((row) => row.id === fixture.acceptedRow.id)!,
      rows.find((row) => row.id === fixture.rejectedRow.id)!,
    ]);
  expect(savedAcceptedRow).toMatchObject({
    resolutionMethod: "AI_CONFIRMED",
    resolvedSkuId: fixture.acceptedSku.id,
    status: "READY",
  });
  expect(savedRejectedRow).toMatchObject({
    resolutionMethod: "LEGACY",
    resolvedSkuId: null,
    status: "UNKNOWN_SKU",
  });
  await expect(
    db
      .select({ id: skuAliases.id })
      .from(skuAliases)
      .where(
        inArray(skuAliases.externalSku, [
          "UNKNOWN-RED-150-80",
          "UNKNOWN-BLUE-200-100",
        ]),
      ),
  ).resolves.toEqual([]);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("AI SKU suggestion cards remain usable at every approved viewport @desktop-only", async ({
  page,
}, testInfo) => {
  const fixture = await seedAiSkuReviewFixture({ enabled: true });
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of [
    { height: 800, width: 360 },
    { height: 844, width: 390 },
    { height: 900, width: 430 },
    { height: 900, width: 1440 },
    { height: 1080, width: 1920 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/portal/imports/${fixture.batch.id}`);
    await expect(page.getByRole("region", { name: "DeepSeek 智能建议" }).first()).toBeVisible();
    const candidate = page.getByRole("button", { name: "使用 TZX-AI-RED-150X80" });
    const candidateBox = await candidate.boundingBox();
    expect(candidateBox).not.toBeNull();
    expect(candidateBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${viewport.width}x${viewport.height} horizontal overflow`).toBeLessThanOrEqual(1);
    await testInfo.attach(`ai-sku-review-${viewport.width}x${viewport.height}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});
