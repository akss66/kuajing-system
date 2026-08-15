import AxeBuilder from "@axe-core/playwright";
import { DateTime } from "luxon";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  customers,
  feishuCargoMigrationRuns,
  fulfillmentOrders,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryStocktakeBatches,
  orderShipments,
  products,
  replacementRequests,
  skus,
  stores,
} from "@/db/schema";
import { seed } from "@/db/seed";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import { loginThroughUi } from "./support/managed-user";
import {
  assertCurrentE2ETestDatabase,
  resetE2EDatabaseToSeedState,
} from "./support/test-database";

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
};

const viewports = [
  { height: 900, kind: "desktop", width: 1440 },
  { height: 1080, kind: "desktop", width: 1920 },
  { height: 900, kind: "mobile", width: 430 },
  { height: 844, kind: "mobile", width: 390 },
  { height: 800, kind: "mobile", width: 360 },
] as const;

const acceptance = {
  longLegacyReason:
    "历史仓库人工修正原因快照：跨境运输异常、包装复核与加拿大仓交接差异的完整说明，仅用于验证旧流水原因在窄屏和桌面表格中安全换行。",
  longName:
    "加拿大仓库存验收专用超长规格名称：防潮加厚包装、独立颜色标签、多件组合销售与跨境冬季运输保护层，验证移动卡片和桌面表格不会与价格或操作区域重叠。",
  longRemark:
    "线下仓库历史补录：客户自提单据 OFFLINE-20260814-0001，包含超长备注以验证原因、操作人、来源、时间和关联单据在窄屏卡片内完整换行且不发生横向溢出。",
  operatorId: "00000000-0000-4000-8000-00000000a001",
  primarySkuCode: "INV-E2E-LONG-SKU-2026-08-14-PRIMARY",
  secondarySkuCode: "INV-E2E-SECONDARY-LOCKED",
} as const;

const ids = {
  feishuRun: "30000000-0000-4000-8000-000000000001",
  normalShipment: "30000000-0000-4000-8000-000000000002",
  order: "30000000-0000-4000-8000-000000000003",
  originalShipment: "30000000-0000-4000-8000-000000000004",
  primaryProduct: "30000000-0000-4000-8000-000000000005",
  primarySku: "30000000-0000-4000-8000-000000000006",
  replacement: "30000000-0000-4000-8000-000000000007",
  replacementShipment: "30000000-0000-4000-8000-000000000008",
  reservation: "30000000-0000-4000-8000-000000000009",
  secondaryProduct: "30000000-0000-4000-8000-000000000010",
  secondarySku: "30000000-0000-4000-8000-000000000011",
  stocktakeBatch: "30000000-0000-4000-8000-000000000012",
} as const;

const movementId = (sequence: number) =>
  `40000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;

const acceptanceReferenceDate = DateTime.now()
  .setZone(BUSINESS_TIME_ZONE)
  .toISODate()!;

function acceptanceDateTime(hour: number, minute = 0) {
  return DateTime.fromISO(acceptanceReferenceDate, {
    zone: BUSINESS_TIME_ZONE,
  })
    .set({ hour, minute })
    .toJSDate();
}

function businessIsoDate(date: Date) {
  return (
    DateTime.fromJSDate(date, { zone: BUSINESS_TIME_ZONE })
      .setZone(BUSINESS_TIME_ZONE)
      .toISODate() ?? acceptanceReferenceDate
  );
}

function observeBrowserFailures(page: Page) {
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

async function expectNoOverflow(page: Page, context: string) {
  const result = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - clientWidth;
    const offenders = [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          (rect.left < -1 || rect.right > clientWidth + 1)
        );
      })
      .slice(0, 8)
      .map((element) => ({
        ariaLabel: element.getAttribute("aria-label"),
        className: element.className.toString().slice(0, 120),
        tagName: element.tagName,
      }));
    return { offenders, overflow };
  });
  expect(
    result.overflow,
    `${context} horizontal overflow; offenders=${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(1);
}

async function expectAxeClean(page: Page, context: string) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
    `${context} serious/critical axe violations`,
  ).toEqual([]);
}

async function expectTouchTarget(locator: Locator, context: string) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${context} bounding box`).not.toBeNull();
  expect(box!.height, `${context} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${context} width`).toBeGreaterThanOrEqual(44);
}

async function expectContained(inner: Locator, outer: Locator, context: string) {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  expect(innerBox, `${context} inner box`).not.toBeNull();
  expect(outerBox, `${context} outer box`).not.toBeNull();
  expect(innerBox!.x, `${context} left`).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.x + innerBox!.width, `${context} right`).toBeLessThanOrEqual(
    outerBox!.x + outerBox!.width + 1,
  );
}

async function expectNoInternalOverflow(locator: Locator, context: string) {
  const overflow = await locator.evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }));
  expect(overflow.horizontal, `${context} horizontal internal overflow`).toBeLessThanOrEqual(1);
  expect(overflow.vertical, `${context} vertical internal overflow`).toBeLessThanOrEqual(1);
}

async function expectNoOverlap(left: Locator, right: Locator, context: string) {
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox, `${context} left box`).not.toBeNull();
  expect(rightBox, `${context} right box`).not.toBeNull();
  const overlapWidth = Math.max(
    0,
    Math.min(leftBox!.x + leftBox!.width, rightBox!.x + rightBox!.width) -
      Math.max(leftBox!.x, rightBox!.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(leftBox!.y + leftBox!.height, rightBox!.y + rightBox!.height) -
      Math.max(leftBox!.y, rightBox!.y),
  );
  expect(overlapWidth * overlapHeight, `${context} overlap area`).toBeLessThanOrEqual(1);
}

async function seedInventoryAcceptanceData() {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.loginIdentifier, seededSuperAdmin.email))
    .limit(1);
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.code, "DEMO-CUSTOMER"))
    .limit(1);
  if (!admin || !customer) throw new Error("Inventory E2E base seed is incomplete");
  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(eq(stores.customerId, customer.id))
    .limit(1);
  if (!store) throw new Error("Inventory E2E seed store is missing");

  await db.insert(products).values([
    { id: ids.primaryProduct, name: "库存流水验收主商品" },
    { id: ids.secondaryProduct, name: "库存流水验收次商品" },
  ]);
  await db.insert(skus).values([
    {
      defaultUnitPriceFen: 325,
      defaultUnitPriceMilliYuan: 3250,
      id: ids.primarySku,
      name: acceptance.longName,
      productId: ids.primaryProduct,
      skuCode: acceptance.primarySkuCode,
      specification: acceptance.longName,
    },
    {
      defaultUnitPriceFen: 520,
      defaultUnitPriceMilliYuan: 5200,
      id: ids.secondarySku,
      name: "锁定库存边界 SKU",
      productId: ids.secondaryProduct,
      skuCode: acceptance.secondarySkuCode,
      specification: "订单锁定数量高于当前总量的历史边界场景",
    },
  ]);
  await db.insert(inventoryBalances).values([
    { skuId: ids.primarySku, totalQuantity: 50 },
    { skuId: ids.secondarySku, totalQuantity: 2 },
  ]);
  await db.insert(inventoryReservations).values([
    {
      id: ids.reservation,
      quantity: 7,
      referenceId: ids.order,
      referenceType: "FULFILLMENT_ORDER",
      skuId: ids.primarySku,
      status: "ACTIVE",
    },
    {
      quantity: 5,
      referenceId: "locked-secondary",
      referenceType: "FULFILLMENT_ORDER",
      skuId: ids.secondarySku,
      status: "ACTIVE",
    },
  ]);
  await db.insert(fulfillmentOrders).values({
    customerId: customer.id,
    id: ids.order,
    orderNumber: "INV-E2E-ORDER-20260814",
    paymentMode: "DIRECT_OFFLINE",
    source: "MANUAL",
    status: "SHIPPED",
    storeId: store.id,
    submittedAt: new Date("2026-08-14T04:10:00.000Z"),
    totalAmountFen: 325,
    totalPackageCount: 1,
    totalQuantity: 1,
  });
  await db.insert(orderShipments).values([
    {
      externalOrderNo: "INV-E2E-NORMAL",
      id: ids.normalShipment,
      kind: "NORMAL",
      orderId: ids.order,
      recipientPayloadEncrypted: "e2e-encrypted-normal",
      shippedAt: new Date("2026-08-14T15:00:00.000Z"),
      storeId: store.id,
    },
    {
      externalOrderNo: "INV-E2E-ORIGINAL",
      id: ids.originalShipment,
      kind: "NORMAL",
      orderId: ids.order,
      recipientPayloadEncrypted: "e2e-encrypted-original",
      shippedAt: new Date("2026-08-14T14:00:00.000Z"),
      storeId: store.id,
    },
    {
      externalOrderNo: "INV-E2E-REPLACEMENT",
      id: ids.replacementShipment,
      kind: "REPLACEMENT",
      orderId: ids.order,
      recipientPayloadEncrypted: "e2e-encrypted-replacement",
      shippedAt: new Date("2026-08-14T16:00:00.000Z"),
      storeId: store.id,
    },
  ]);
  await db.insert(replacementRequests).values({
    createdByAdminUserId: admin.id,
    id: ids.replacement,
    orderId: ids.order,
    originalShipmentId: ids.originalShipment,
    reason: "运输破损补发",
    replacementShipmentId: ids.replacementShipment,
    status: "SHIPPED",
  });
  await db.insert(feishuCargoMigrationRuns).values({
    createdAt: new Date("2026-08-14T10:00:00.000Z"),
    createdByAdminUserId: admin.id,
    id: ids.feishuRun,
    normalizedRowsJson: [],
    sourceDigest: "b".repeat(64),
    sourceRevision: 1,
    sourceSheetId: "inventory-e2e-read-only-source",
    sourceSpreadsheetHash: "a".repeat(64),
    status: "PREFLIGHT_READY",
    summaryJson: {
      imageCount: 0,
      productCount: 0,
      skuCount: 0,
      sourceSequenceCount: 0,
      totalQuantity: 0,
    },
    updatedAt: new Date("2026-08-14T10:00:00.000Z"),
  });
  await db.insert(inventoryStocktakeBatches).values({
    actorId: acceptance.operatorId,
    createdAt: new Date("2026-08-14T12:00:00.000Z"),
    id: ids.stocktakeBatch,
    remark: "月末盘点验收批次",
  });

  const genericMovements = Array.from({ length: 22 }, (_, index) => ({
    actorId: acceptance.operatorId,
    actorType: "ADMIN" as const,
    afterQuantity: 101 + index,
    beforeQuantity: 100 + index,
    createdAt: new Date(Date.UTC(2026, 7, 13, 0, index)),
    delta: 1,
    id: movementId(index + 1),
    movementType: "MANUAL_INCREASE" as const,
    reason: "补货入库",
    reasonCode: "RESTOCK_RECEIPT" as const,
    remark: index === 0 ? "第二页确定性分页锚点" : null,
    skuId: ids.primarySku,
  }));
  await db.insert(inventoryMovements).values([
    ...genericMovements,
    {
      actorId: null,
      actorType: "SYSTEM",
      afterQuantity: 49,
      beforeQuantity: 50,
      createdAt: new Date("2026-08-14T16:00:00.000Z"),
      delta: -1,
      id: movementId(906),
      movementType: "SHIPMENT",
      reason: "系统发货扣减",
      reasonCode: "SYSTEM_SHIPMENT",
      referenceId: ids.replacementShipment,
      referenceType: "ORDER_SHIPMENT",
      skuId: ids.primarySku,
    },
    {
      actorId: null,
      actorType: "SYSTEM",
      afterQuantity: 48,
      beforeQuantity: 49,
      createdAt: new Date("2026-08-14T15:00:00.000Z"),
      delta: -1,
      id: movementId(905),
      movementType: "SHIPMENT",
      reason: "系统发货扣减",
      reasonCode: "SYSTEM_SHIPMENT",
      referenceId: ids.normalShipment,
      referenceType: "ORDER_SHIPMENT",
      skuId: ids.primarySku,
    },
    {
      actorId: acceptance.operatorId,
      actorType: "ADMIN",
      afterQuantity: 47,
      beforeQuantity: 50,
      createdAt: acceptanceDateTime(14),
      delta: -3,
      id: movementId(904),
      movementType: "MANUAL_DECREASE",
      reason: "线下发货/人工出库",
      reasonCode: "OFFLINE_FULFILLMENT",
      remark: acceptance.longRemark,
      skuId: ids.primarySku,
    },
    {
      actorId: acceptance.operatorId,
      actorType: "ADMIN",
      afterQuantity: 10,
      beforeQuantity: 0,
      createdAt: new Date("2026-08-14T13:00:00.000Z"),
      delta: 10,
      id: movementId(903),
      movementType: "MANUAL_INCREASE",
      reason: "飞书初始导入",
      reasonCode: "FEISHU_INITIAL_IMPORT",
      referenceId: ids.feishuRun,
      referenceType: "FEISHU_CARGO_MIGRATION",
      skuId: ids.secondarySku,
    },
    {
      actorId: acceptance.operatorId,
      actorType: "ADMIN",
      afterQuantity: 51,
      beforeQuantity: 50,
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
      delta: 1,
      id: movementId(902),
      movementType: "MANUAL_INCREASE",
      reason: "盘点调整",
      reasonCode: "STOCKTAKE_CORRECTION",
      skuId: ids.primarySku,
      stocktakeBatchId: ids.stocktakeBatch,
    },
    {
      actorId: "retired-inventory-operator",
      actorType: "ADMIN",
      afterQuantity: 52,
      beforeQuantity: 51,
      createdAt: new Date("2026-08-14T11:00:00.000Z"),
      delta: 1,
      id: movementId(901),
      movementType: "MANUAL_INCREASE",
      reason: acceptance.longLegacyReason,
      reasonCode: null,
      skuId: ids.primarySku,
    },
  ]);
}

async function resetInventoryAcceptanceBaseline() {
  await resetE2EDatabaseToSeedState({
    context: "inventory movement E2E reset",
    database: db,
    reseed: seed,
  });
  await assertCurrentE2ETestDatabase(db, "inventory movement E2E fixture");
  await db.delete(inventoryStocktakeBatches);
  await seedInventoryAcceptanceData();
}

async function loginAndOpenInventory(page: Page) {
  await loginThroughUi(page, seededSuperAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/inventory");
  await expect(page.getByRole("heading", { level: 1, name: "货盘库存" })).toBeVisible();
}

async function openAdjustment(page: Page, skuCode = acceptance.primarySkuCode) {
  await page.getByRole("button", { name: `+ / - 调整 ${skuCode}` }).click();
  const dialog = page.getByRole("dialog", { name: `${skuCode} 调整库存` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeAdjustment(dialog: Locator) {
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);
}

async function expectMovementFacts(scope: Locator, includeLegacyReason = true) {
  for (const fact of [
    acceptance.primarySkuCode,
    "线下发货/人工出库",
    acceptance.longRemark,
    "本地演示管理员",
    "47",
    "-3",
    ...(includeLegacyReason ? [acceptance.longLegacyReason] : []),
  ]) {
    await expect(scope.getByText(fact, { exact: false }).first()).toBeVisible();
  }
}

async function submitMovementFilters(
  page: Page,
  values: {
    actorId?: string;
    from?: string;
    movementType?: string;
    skuCode?: string;
    source?: string;
    to?: string;
  },
) {
  const form = page.getByRole("search", { name: "筛选库存流水" });
  if (values.skuCode !== undefined) await form.getByLabel("SKU").fill(values.skuCode);
  if (values.from !== undefined) await form.getByLabel("开始时间").fill(values.from);
  if (values.to !== undefined) await form.getByLabel("结束时间").fill(values.to);
  if (values.movementType !== undefined) {
    await form.getByLabel("流水类型").selectOption(values.movementType);
  }
  if (values.actorId !== undefined) await form.getByLabel("操作人").fill(values.actorId);
  if (values.source !== undefined) await form.getByLabel("来源").selectOption(values.source);
  await form.getByRole("button", { name: "应用筛选" }).click();
}

async function tabUntilName(page: Page, name: string, maximumTabs = 30) {
  for (let index = 0; index < maximumTabs; index += 1) {
    const activeName = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) {
        return active.name;
      }
      return active.textContent?.trim() || active.getAttribute("aria-label");
    });
    if (activeName === name || activeName?.includes(name)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${name}`);
}

test.describe.configure({ mode: "serial", timeout: 600_000 });
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });

test("inventory adjustment, stocktake, filters, relations, and pagination preserve audit semantics @desktop-only", async ({
  page,
}) => {
  const failures = observeBrowserFailures(page);
  await resetInventoryAcceptanceBaseline();
  await loginAndOpenInventory(page);

  const tabs = page.getByRole("tablist", { name: "库存视图" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs).toHaveText(["实时库存", "库存流水"]);
  await expect(page.getByRole("tab", { name: "批量盘点" })).toHaveCount(0);

  let dialog = await openAdjustment(page);
  const quantity = dialog.getByLabel("调整数量");
  const reason = dialog.getByLabel("调整原因");
  await expect(dialog.getByLabel("增加")).toBeChecked();
  await expect(reason).toHaveValue("RESTOCK_RECEIPT");
  await expect(reason.locator("option")).toHaveText([
    "补货入库",
    "客户退货入库",
    "其他入库",
  ]);
  await expect(quantity).toHaveAttribute("min", "1");
  await expect(quantity).toHaveAttribute("step", "1");
  await quantity.fill("0");
  await expect(dialog.getByRole("button", { name: "确认调整库存" })).toBeDisabled();
  await quantity.fill("5");
  const preview = dialog.getByRole("region", { name: "库存调整预览" });
  for (const [label, value] of [
    ["调整前总库存", "50"],
    ["变化量", "+5"],
    ["调整后总库存", "55"],
    ["订单锁定", "7"],
    ["当前可售", "43"],
    ["调整后可售", "48"],
  ]) {
    await expect(preview.getByText(label).locator("..")).toContainText(value);
  }
  await dialog.getByLabel("备注（可选）").fill("  E2E 补货批次 A-001  ");
  await dialog.getByRole("button", { name: "确认调整库存" }).click();
  await expect(dialog.getByText("库存已调整并记录流水。")).toBeVisible();
  await expect.poll(async () => {
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.skuId, ids.primarySku),
          eq(inventoryMovements.remark, "E2E 补货批次 A-001"),
        ),
      )
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(1);
    return movement ?? null;
  }).toMatchObject({
    actorType: "ADMIN",
    delta: 5,
    movementType: "MANUAL_INCREASE",
    reason: "补货入库",
    reasonCode: "RESTOCK_RECEIPT",
    referenceId: null,
    referenceType: null,
    remark: "E2E 补货批次 A-001",
  });
  await closeAdjustment(dialog);

  dialog = await openAdjustment(page);
  await dialog.getByText("减少", { exact: true }).click();
  await expect(dialog.getByLabel("调整原因")).toHaveValue("OFFLINE_FULFILLMENT");
  await expect(dialog.getByLabel("调整原因").locator("option")).toHaveText([
    "线下发货/人工出库",
    "破损报废",
    "其他出库",
  ]);
  await expect(
    dialog.getByText(
      "仅用于未经过本系统订单的线下发货或历史补录；系统订单确认发货后会自动扣减，请勿重复调整。",
    ),
  ).toBeVisible();
  await dialog.getByLabel("调整数量").fill("49");
  await expect(dialog.getByRole("alert")).toContainText("不能低于订单锁定 7");
  await expect(dialog.getByRole("button", { name: "确认调整库存" })).toBeDisabled();
  await dialog.getByLabel("调整数量").fill("2");
  await dialog.getByLabel("备注（可选）").fill("  E2E 线下发货补录  ");
  await dialog.getByRole("button", { name: "确认调整库存" }).click();
  await expect(dialog.getByText("库存已调整并记录流水。")).toBeVisible();
  await expect.poll(async () => {
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.remark, "E2E 线下发货补录"))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(1);
    return movement ?? null;
  }).toMatchObject({
    actorType: "ADMIN",
    delta: -2,
    movementType: "MANUAL_DECREASE",
    reason: "线下发货/人工出库",
    reasonCode: "OFFLINE_FULFILLMENT",
    referenceId: null,
    referenceType: null,
  });
  const [offlineFulfillmentMovement] = await db
    .select({ createdAt: inventoryMovements.createdAt })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.remark, "E2E 线下发货补录"))
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(1);

  await dialog.getByRole("button", { name: "设置为实际库存" }).click();
  const actual = dialog.getByLabel("盘点后实际总库存");
  await actual.fill("53");
  await expect(dialog.getByText("无变化，不生成库存流水。")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认盘点结果" })).toBeDisabled();
  await actual.fill("54");
  await dialog.getByLabel("盘点备注（可选）").fill("  E2E 月末盘点差异  ");
  await dialog.getByRole("button", { name: "确认盘点结果" }).click();
  await expect(dialog.getByText("盘点库存已更新并记录流水。")).toBeVisible();
  await expect.poll(async () => {
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.remark, "E2E 月末盘点差异"))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(1);
    return movement ?? null;
  }).toMatchObject({
    delta: 1,
    reasonCode: "STOCKTAKE_CORRECTION",
    remark: "E2E 月末盘点差异",
  });
  await closeAdjustment(dialog);

  await page.getByRole("tab", { name: "库存流水" }).click();
  await expect(page).toHaveURL(/view=movements/);
  const table = page.getByRole("table", { name: "库存流水列表" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText([
    "SKU",
    "前值",
    "变动",
    "后值",
    "原因与备注",
    "操作人",
    "来源",
    "时间",
    "关联单据",
  ]);
  await expect(table.getByRole("row")).toHaveCount(21);
  await expect(table.getByText("系统订单自动发货").first()).toBeVisible();
  await expect(table.getByText("线下发货/人工出库").first()).toBeVisible();
  await expect(table.getByRole("link", { name: "补发 · INV-E2E-ORDER-20260814" })).toHaveAttribute(
    "href",
    `/admin/orders/${ids.order}`,
  );
  await expect(table.getByRole("link", { name: "订单 · INV-E2E-ORDER-20260814" })).toHaveAttribute(
    "href",
    `/admin/orders/${ids.order}`,
  );
  await expect(table.getByRole("link", { name: /飞书迁移 · 30000000/ })).toHaveAttribute(
    "href",
    "/admin/system/integrations",
  );
  await expect(table.getByText(/盘点批次 · 30000000/)).toBeVisible();
  await expect(page.getByText(/第 1 \/ 2 页 · 共 31 条/)).toBeVisible();

  await submitMovementFilters(page, {
    actorId: acceptance.operatorId,
    from: acceptanceReferenceDate,
    movementType: "MANUAL_DECREASE",
    skuCode: acceptance.primarySkuCode,
    source: "ADMIN_OFFLINE_FULFILLMENT",
    to: businessIsoDate(offlineFulfillmentMovement!.createdAt),
  });
  await expect(page).toHaveURL(/sku=INV-E2E-LONG-SKU/);
  await expect(
    page.getByRole("table", { name: "库存流水列表" }).locator("tbody tr"),
  ).toHaveCount(2);
  await expectMovementFacts(
    page.getByRole("table", { name: "库存流水列表" }),
    false,
  );
  await page.getByRole("link", { name: "重置筛选" }).click();
  await expect(page).toHaveURL(/\/admin\/inventory\?view=movements$/);
  const resetForm = page.getByRole("search", { name: "筛选库存流水" });
  await expect(resetForm.getByLabel("SKU")).toHaveValue("");
  await expect(resetForm.getByLabel("开始时间")).toHaveValue("");
  await expect(resetForm.getByLabel("结束时间")).toHaveValue("");
  await expect(resetForm.getByLabel("流水类型")).toHaveValue("");
  await expect(resetForm.getByLabel("操作人")).toHaveValue("");
  await expect(resetForm.getByLabel("来源")).toHaveValue("");

  await submitMovementFilters(page, { source: "SYSTEM_ORDER_SHIPMENT" });
  await expect(page.getByText(/共 2 条/)).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "库存流水列表" })
      .getByText("系统订单自动发货"),
  ).toHaveCount(2);
  await page.getByRole("link", { name: "重置筛选" }).click();
  await page.getByRole("link", { name: "下一页" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page
      .getByRole("table", { name: "库存流水列表" })
      .getByText("第二页确定性分页锚点"),
  ).toBeVisible();

  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);
});

test("administrator can complete a core inventory increase with keyboard input only @mobile-only", async ({
  page,
}) => {
  const failures = observeBrowserFailures(page);
  await resetInventoryAcceptanceBaseline();
  await page.setViewportSize({ height: 844, width: 390 });
  await loginAndOpenInventory(page);

  const trigger = page.getByRole("button", {
    name: `+ / - 调整 ${acceptance.primarySkuCode}`,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: `${acceptance.primarySkuCode} 调整库存`,
  });
  await expect(dialog).toBeVisible();
  await tabUntilName(page, "quantity");
  await page.keyboard.type("4");
  await tabUntilName(page, "reasonCode");
  await expect(dialog.getByLabel("调整原因")).toHaveValue("RESTOCK_RECEIPT");
  await tabUntilName(page, "remark");
  await page.keyboard.type("E2E keyboard only restock");
  await tabUntilName(page, "确认调整库存");
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("库存已调整并记录流水。")).toBeVisible();
  await expect.poll(async () => {
    const [movement] = await db
      .select({ delta: inventoryMovements.delta, remark: inventoryMovements.remark })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.remark, "E2E keyboard only restock"))
      .limit(1);
    return movement ?? null;
  }).toEqual({ delta: 4, remark: "E2E keyboard only restock" });
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);
});

test("inventory views and adjustment drawer pass the exact viewport visual matrix without masks @desktop-only", async ({
  page,
}) => {
  const failures = observeBrowserFailures(page);
  await resetInventoryAcceptanceBaseline();
  await loginAndOpenInventory(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of viewports) {
    const context = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto("/admin/inventory");
    await expect(page.getByRole("heading", { level: 1, name: "货盘库存" })).toBeVisible();
    await waitForLayout(page);
    await expectNoOverflow(page, `${context} snapshot`);
    await expectAxeClean(page, `${context} snapshot`);
    const adjustmentTrigger = page.getByRole("button", {
      name: `+ / - 调整 ${acceptance.primarySkuCode}`,
    });
    await expectTouchTarget(adjustmentTrigger, `${context} adjustment trigger`);
    if (viewport.kind === "desktop") {
      const snapshotTable = page.getByRole("table", { name: "实时库存列表" });
      await expect(snapshotTable).toBeVisible();
      const row = snapshotTable.getByRole("row", { name: new RegExp(acceptance.primarySkuCode) });
      const snapshotCells = row.getByRole("cell");
      const nameCell = snapshotCells.nth(1);
      const totalCell = snapshotCells.nth(2);
      await expectContained(
        nameCell.getByText(acceptance.longName),
        nameCell,
        `${context} long snapshot name cell`,
      );
      await expectNoInternalOverflow(nameCell, `${context} long snapshot name cell`);
      await expectNoOverlap(
        nameCell.getByText(acceptance.longName),
        totalCell,
        `${context} snapshot name/total`,
      );
    } else {
      const cards = page.getByRole("list", { name: "实时库存列表" });
      await expect(cards).toBeVisible();
      const card = cards.getByText(acceptance.longName).locator("xpath=ancestor::li[1]");
      await expectContained(card.getByText(acceptance.longName), card, `${context} long snapshot card`);
      await expectNoOverlap(
        card.getByText(acceptance.longName),
        card.getByRole("button", { name: `+ / - 调整 ${acceptance.primarySkuCode}` }),
        `${context} snapshot card name/action`,
      );
    }
    await expect(page).toHaveScreenshot(`inventory-snapshot-${context}.png`, {
      animations: "disabled",
      fullPage: true,
    });

    const dialog = await openAdjustment(page);
    await dialog.getByText("减少", { exact: true }).click();
    await dialog.getByLabel("调整数量").fill("2");
    await expect(dialog.getByRole("region", { name: "库存调整预览" })).toBeVisible();
    await expect(dialog.getByText("仅用于未经过本系统订单的线下发货或历史补录", { exact: false })).toBeVisible();
    await expectTouchTarget(
      dialog.getByRole("button", { name: "确认调整库存" }),
      `${context} drawer submit`,
    );
    await expectNoOverflow(page, `${context} adjustment drawer`);
    await expectAxeClean(page, `${context} adjustment drawer`);
    await expect(page).toHaveScreenshot(`inventory-adjustment-${context}.png`, {
      animations: "disabled",
      fullPage: true,
    });
    await closeAdjustment(dialog);

    await page.goto("/admin/inventory?view=movements");
    await expect(page.getByRole("region", { name: "库存流水" })).toBeVisible();
    await waitForLayout(page);
    await expectNoOverflow(page, `${context} movements`);
    await expectAxeClean(page, `${context} movements`);
    if (viewport.kind === "desktop") {
      const movementTable = page.getByRole("table", { name: "库存流水列表" });
      await expect(movementTable).toBeVisible();
      await expectMovementFacts(movementTable);
      const movementRow = movementTable.getByRole("row", {
        name: new RegExp("线下仓库历史补录"),
      });
      const movementCells = movementRow.getByRole("cell");
      const reasonCell = movementCells.nth(4);
      const operatorCell = movementCells.nth(5);
      await expectContained(
        reasonCell.getByText(acceptance.longRemark),
        reasonCell,
        `${context} movement remark cell`,
      );
      await expectNoInternalOverflow(reasonCell, `${context} movement reason cell`);
      await expectNoInternalOverflow(operatorCell, `${context} movement operator cell`);
      await expectNoOverlap(
        reasonCell.getByText(acceptance.longRemark),
        operatorCell,
        `${context} movement remark/operator`,
      );
    } else {
      const movementCards = page.getByRole("list", { name: "库存流水列表" });
      await expect(movementCards).toBeVisible();
      await expectMovementFacts(movementCards);
      const movementCard = movementCards
        .getByText(acceptance.longRemark)
        .locator("xpath=ancestor::li[1]");
      await expectContained(
        movementCard.getByText(acceptance.longRemark),
        movementCard,
        `${context} movement remark card`,
      );
      await expectTouchTarget(
        page.getByRole("button", { name: "应用筛选" }),
        `${context} filter submit`,
      );
    }
    await expect(page).toHaveScreenshot(`inventory-movements-${context}.png`, {
      animations: "disabled",
      fullPage: true,
    });
  }

  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.hydrationErrors).toEqual([]);
});
