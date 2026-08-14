import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { buildFieldAlignedCargoSourceFixture } from "@/../tests/fixtures/feishu/field-aligned-cargo-source";
import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  adminUsers,
  authUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  inventoryBalances,
  integrationOutbox,
  products,
  skus,
} from "@/db/schema";
import { FeishuClient } from "@/integrations/feishu/client";
import { createFeishuCargoMigrationService } from "@/modules/feishu/migration-service";

import { createManagedUser, loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const FEISHU_PORT = 4010;
const FEISHU_BASE_URL = `http://127.0.0.1:${FEISHU_PORT}`;
const SOURCE_WIKI_TOKEN = "wiki-source-token";
const SOURCE_SPREADSHEET_TOKEN = "source-spreadsheet-token";
const TARGET_SPREADSHEET_TOKEN = "target-spreadsheet-token";
const TARGET_SHEET_ID = "target-sheet-id";
const LONG_SPECIFICATION =
  "跨境仓配字段验收专用超长规格：适配加拿大冬季运输场景，包含加厚防潮内衬、可重复封装保护层、独立颜色标签与多件组合销售说明，用于验证桌面表格和移动卡片在真实长文本下仍能稳定换行且不侵入价格、库存与状态区域。";
const APPROVED_VIEWPORTS = [
  { height: 900, width: 1440 },
  { height: 1080, width: 1920 },
  { height: 900, width: 430 },
  { height: 844, width: 390 },
  { height: 800, width: 360 },
] as const;

const seededSuperAdmin = {
  email: "admin@tongzhouxing.local",
  password: "TongZhouXing-Admin-2026!",
  userId: "00000000-0000-4000-8000-00000000a001",
};

const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

type DownloadRecord = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
};

type FakeFeishuDataset = {
  downloads: Map<string, DownloadRecord>;
  values: unknown[][];
};

type FakeWriteRecord = {
  body: unknown;
  method: string;
  path: string;
  spreadsheetToken: string;
};

class FakeFeishuServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });

  readonly sourceWrites: FakeWriteRecord[] = [];
  readonly targetWrites: FakeWriteRecord[] = [];

  constructor(
    private readonly dataset: FakeFeishuDataset,
    private readonly revision = 112,
  ) {}

  async listen() {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(FEISHU_PORT, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close() {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", FEISHU_BASE_URL);
    const path = url.pathname;

    if (method === "POST" && path === "/open-apis/auth/v3/tenant_access_token/internal") {
      this.json(response, {
        code: 0,
        expire: 7200,
        tenant_access_token: "tenant-access-token",
      });
      return;
    }

    if (method === "GET" && path === "/open-apis/wiki/v2/spaces/get_node") {
      this.json(response, {
        code: 0,
        data: {
          node: {
            obj_token: SOURCE_SPREADSHEET_TOKEN,
            obj_type: "sheet",
          },
        },
      });
      return;
    }

    if (
      method === "GET" &&
      path === `/open-apis/sheets/v3/spreadsheets/${SOURCE_SPREADSHEET_TOKEN}/sheets/query`
    ) {
      this.json(response, {
        code: 0,
        data: {
          sheets: [
            { index: 0, sheet_id: "sheet-source-a", title: "货盘 A" },
            { index: 1, sheet_id: "sheet-source-b", title: "货盘 B" },
          ],
        },
      });
      return;
    }

    if (
      method === "GET" &&
      path === `/open-apis/sheets/v3/spreadsheets/${TARGET_SPREADSHEET_TOKEN}/sheets/query`
    ) {
      this.json(response, {
        code: 0,
        data: {
          sheets: [
            { index: 0, sheet_id: TARGET_SHEET_ID, title: "目标测试表" },
          ],
        },
      });
      return;
    }

    const sourceRangePrefix = `/open-apis/sheets/v2/spreadsheets/${SOURCE_SPREADSHEET_TOKEN}/values/`;
    if (method === "GET" && path.startsWith(sourceRangePrefix)) {
      const range = decodeURIComponent(path.slice(sourceRangePrefix.length));
      if (range !== "sheet-source-a!A1:Z500") {
        this.json(response, { code: 404, msg: `Unknown source range ${range}` }, 404);
        return;
      }
      this.json(response, {
        code: 0,
        data: {
          valueRange: {
            range: "sheet-source-a!A1:Z500",
            revision: this.revision,
            values: this.dataset.values,
          },
        },
      });
      return;
    }

    const targetRangePrefix = `/open-apis/sheets/v2/spreadsheets/${TARGET_SPREADSHEET_TOKEN}/values/`;
    if (method === "GET" && path.startsWith(targetRangePrefix)) {
      this.json(response, {
        code: 0,
        data: {
          valueRange: {
            range: `${TARGET_SHEET_ID}!A1:M5000`,
            revision: 0,
            values: [],
          },
        },
      });
      return;
    }

    if (method === "GET" && path.startsWith("/open-apis/drive/v1/medias/")) {
      const fileToken = decodeURIComponent(
        path.replace("/open-apis/drive/v1/medias/", "").replace("/download", ""),
      );
      const record = this.dataset.downloads.get(fileToken);
      if (!record) {
        this.json(response, { code: 404, msg: "missing file" }, 404);
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Disposition", `attachment; filename="${record.fileName}"`);
      response.setHeader("Content-Length", record.bytes.byteLength);
      response.setHeader("Content-Type", record.contentType);
      response.end(record.bytes);
      return;
    }

    if (path.includes(`/open-apis/sheets/v2/spreadsheets/${TARGET_SPREADSHEET_TOKEN}/`)) {
      await this.recordWrite(request, path, TARGET_SPREADSHEET_TOKEN, this.targetWrites);
      this.json(response, { code: 0, data: {} });
      return;
    }

    if (path.includes(`/open-apis/sheets/v3/spreadsheets/${TARGET_SPREADSHEET_TOKEN}/`)) {
      await this.recordWrite(request, path, TARGET_SPREADSHEET_TOKEN, this.targetWrites);
      this.json(response, { code: 0, data: {} });
      return;
    }

    if (path.includes(`/open-apis/sheets/v2/spreadsheets/${SOURCE_SPREADSHEET_TOKEN}/`)) {
      await this.recordWrite(request, path, SOURCE_SPREADSHEET_TOKEN, this.sourceWrites);
      this.json(response, { code: 0, data: {} });
      return;
    }

    if (path.includes(`/open-apis/sheets/v3/spreadsheets/${SOURCE_SPREADSHEET_TOKEN}/`)) {
      await this.recordWrite(request, path, SOURCE_SPREADSHEET_TOKEN, this.sourceWrites);
      this.json(response, { code: 0, data: {} });
      return;
    }

    this.json(response, { code: 404, msg: `Unhandled route: ${method} ${path}` }, 404);
  }

  private async recordWrite(
    request: IncomingMessage,
    path: string,
    spreadsheetToken: string,
    bucket: FakeWriteRecord[],
  ) {
    const body = await this.readJsonBody(request);
    bucket.push({
      body,
      method: request.method ?? "POST",
      path,
      spreadsheetToken,
    });
  }

  private json(response: ServerResponse, body: unknown, statusCode = 200) {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  private async readJsonBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
}

async function createImageBuffer(seedValue: number) {
  return await sharp({
    create: {
      background: {
        alpha: 1,
        b: (seedValue * 41) % 255,
        g: (seedValue * 23) % 255,
        r: (seedValue * 11) % 255,
      },
      channels: 4,
      height: 12,
      width: 12,
    },
  })
    .png()
    .toBuffer();
}

async function buildValidSourceDataset() {
  const downloads = new Map<string, DownloadRecord>();
  const values = structuredClone(buildFieldAlignedCargoSourceFixture().value);
  const dataRows = values.slice(1);

  for (const row of dataRows) {
    if (row[1] === "TZX-034-1") {
      row[6] = "8";
      row[7] = "8";
      row[9] = LONG_SPECIFICATION;
      row[13] = "可售";
    }
    if (row[1] === "TZX-034-2") {
      row[6] = "5";
      row[7] = "5";
      row[9] = "人工不可售但仍有库存";
      row[13] = "不可售";
    }
    if (row[1] === "TZX-034-3") {
      row[6] = "0";
      row[7] = "0";
      row[9] = "可售状态但库存为零";
      row[13] = "可售";
    }
  }

  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    const imageCell = row[2];
    const fileToken =
      imageCell && typeof imageCell === "object" && "fileToken" in imageCell
        ? String((imageCell as { fileToken: string }).fileToken)
        : null;
    if (!fileToken) {
      throw new Error(`Expected fixture fileToken at row ${index + 2}`);
    }

    downloads.set(fileToken, {
      bytes: await createImageBuffer(index + 1),
      contentType: "image/png",
      fileName: `${fileToken}.png`,
    });
  }

  return { downloads, values } satisfies FakeFeishuDataset;
}

function observeBrowserFailures(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const hydrationErrors: string[] = [];

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

async function expectCleanPage(
  page: import("@playwright/test").Page,
  failures: ReturnType<typeof observeBrowserFailures>,
  context: string,
) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${context} document overflow`).toBeLessThanOrEqual(1);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
    `${context} serious/critical axe violations`,
  ).toEqual([]);
  expect(failures.consoleErrors, `${context} console errors`).toEqual([]);
  expect(failures.pageErrors, `${context} page errors`).toEqual([]);
  expect(failures.hydrationErrors, `${context} hydration errors`).toEqual([]);
}

async function clearMigrationDomain() {
  await db.execute(sql.raw(`
    truncate table
      integration_attempts,
      integration_outbox,
      feishu_cargo_migration_runs,
      audit_logs,
      inventory_movements,
      inventory_reservations,
      inventory_balances,
      customer_sku_prices,
      sku_aliases,
      skus,
      products,
      catalog_assets
    restart identity cascade
  `));
}

async function resetMigrationBaseline(assetDir: string) {
  await resetE2EDatabaseToSeedState({
    context: "feishu cargo migration e2e reset",
    database: db,
    reseed: seed,
  });
  await clearMigrationDomain();
  await rm(assetDir, { force: true, recursive: true });
}

async function openFeishuDrawer(page: import("@playwright/test").Page) {
  await page.goto("/admin/system/integrations");
  await page.getByRole("button", { name: "管理飞书" }).click();
  const drawer = page.getByRole("dialog", { name: "管理飞书集成" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function expectVisibleWithoutScroll(
  element: import("@playwright/test").Locator,
  page: import("@playwright/test").Page,
) {
  await expect(element).toBeVisible();
  const box = await element.boundingBox();
  const viewport = page.viewportSize();

  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function createOrdinaryAdmin() {
  const credentials = await createManagedUser({ role: "admin" });
  const [user] = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, credentials.userId));
  await db.insert(adminUsers).values({
    displayName: "E2E 普通管理员",
    loginIdentifier: user.email,
    status: "ACTIVE",
  });
  return credentials;
}

async function runReadyPreflight(assetDir: string) {
  const service = createFeishuCargoMigrationService({ assetDir });
  const client = new FeishuClient({
    appId: "e2e-feishu-app-id",
    appSecret: "e2e-feishu-app-secret",
    baseUrl: FEISHU_BASE_URL,
  });
  const result = await service.createCargoPreflight({
    actor: { kind: "SUPER_ADMIN", userId: seededSuperAdmin.userId },
    client,
    config: {
      sourceSheetId: "sheet-source-a",
      sourceWikiToken: SOURCE_WIKI_TOKEN,
    },
  });
  if (!("runId" in result)) {
    throw new Error("Expected a persisted ready preflight run");
  }
  return result.runId;
}

test.describe.serial("Feishu cargo migration", () => {
  test.setTimeout(180_000);
  let fakeServer: FakeFeishuServer | null = null;
  const assetDir = resolve(
    process.cwd(),
    process.env.CATALOG_ASSET_DIR ?? ".e2e-catalog-assets",
  );

  test.beforeEach(async () => {
    process.env.CATALOG_ASSET_DIR = assetDir;
  });

  test.afterEach(async () => {
    if (fakeServer) {
      await fakeServer.close();
      fakeServer = null;
    }
  });

  test("super admin confirms the 74-sequence/140-SKU read-only import with zero Feishu writes @desktop-only", async ({ page }) => {
    const failures = observeBrowserFailures(page);
    await resetMigrationBaseline(assetDir);
    fakeServer = new FakeFeishuServer(await buildValidSourceDataset());
    await fakeServer.listen();

    await page.setViewportSize(APPROVED_VIEWPORTS[0]);

    await loginThroughUi(page, seededSuperAdmin);
    await expect(page).toHaveURL(/\/admin/);

    let drawer = await openFeishuDrawer(page);
    const sourcePicker = drawer.getByRole("combobox", { name: "源工作表" });
    const setupButton = drawer.getByRole("button", { name: "选择源工作表后开始只读预检" });
    await expectVisibleWithoutScroll(sourcePicker, page);
    await expectVisibleWithoutScroll(setupButton, page);
    await expect(setupButton).toHaveJSProperty("disabled", true);
    await sourcePicker.selectOption("sheet-source-a");
    await expect(
      drawer.getByRole("button", { name: "开始只读预检" }),
    ).toHaveJSProperty("disabled", false);
    await drawer.getByRole("button", { name: "开始只读预检" }).click();
    await expect
      .poll(async () => {
        const [latestRun] = await db
          .select({
            id: feishuCargoMigrationRuns.id,
            status: feishuCargoMigrationRuns.status,
          })
          .from(feishuCargoMigrationRuns)
          .orderBy(sql`${feishuCargoMigrationRuns.updatedAt} desc`)
          .limit(1);
        return latestRun?.status ?? null;
      }, { timeout: 30_000 })
      .toBe("PREFLIGHT_READY");

    const [preflightRun] = await db
      .select({ id: feishuCargoMigrationRuns.id })
      .from(feishuCargoMigrationRuns)
      .orderBy(sql`${feishuCargoMigrationRuns.updatedAt} desc`)
      .limit(1);
    if (!preflightRun) {
      throw new Error("Expected a persisted preflight run after ready status");
    }
    expect(fakeServer.sourceWrites).toEqual([]);

    await page.reload();
    drawer = await openFeishuDrawer(page);
    await expect(
      drawer.getByRole("button", { name: "确认迁移 140 个SKU" }),
    ).toBeVisible();
    await drawer.getByLabel("确认语句").fill("确认迁移140个SKU");
    await drawer.getByRole("button", { name: "确认迁移 140 个SKU" }).click();
    const confirmDialog = page.getByRole("alertdialog", {
      name: "确认导入 140 个SKU",
    });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "确认导入 140 个SKU" }).click();
    await expect
      .poll(async () => {
        const [run] = await db
          .select({ status: feishuCargoMigrationRuns.status })
          .from(feishuCargoMigrationRuns)
          .where(eq(feishuCargoMigrationRuns.id, preflightRun.id))
          .limit(1);
        return run?.status ?? null;
      }, { timeout: 90_000 })
      .toBe("IMPORTED");

    const [productCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products);
    const [skuCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skus);
    const [assetCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(catalogAssets);
    const [sourceSequenceCountRow] = await db
      .select({ count: sql<number>`count(distinct ${products.sourceSequence})::int` })
      .from(products);
    expect(productCountRow?.count).toBe(74);
    expect(sourceSequenceCountRow?.count).toBe(74);
    expect(skuCountRow?.count).toBe(140);
    expect(assetCountRow?.count).toBe(140);

    const trio = await db
      .select({
        cargoUnitPriceMilliYuan: products.cargoUnitPriceMilliYuan,
        defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
        saleStatus: skus.saleStatus,
        skuCode: skus.skuCode,
        sourceSequence: products.sourceSequence,
        specification: skus.specification,
        totalQuantity: inventoryBalances.totalQuantity,
      })
      .from(skus)
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
      .where(sql`${skus.skuCode} in ('TZX-034-1', 'TZX-034-2', 'TZX-034-3')`)
      .orderBy(skus.skuCode);
    expect(trio.map((row) => row.skuCode)).toEqual([
      "TZX-034-1",
      "TZX-034-2",
      "TZX-034-3",
    ]);
    expect(new Set(trio.map((row) => row.sourceSequence))).toEqual(new Set(["34"]));
    expect(trio[0]).toMatchObject({
      cargoUnitPriceMilliYuan: 1366,
      defaultUnitPriceMilliYuan: 325,
      saleStatus: "SELLABLE",
      specification: LONG_SPECIFICATION,
      totalQuantity: 8,
    });
    expect(trio[1]).toMatchObject({ saleStatus: "NOT_SELLABLE", totalQuantity: 5 });
    expect(trio[2]).toMatchObject({ saleStatus: "SELLABLE", totalQuantity: 0 });

    expect(await db.select({ id: integrationOutbox.id }).from(integrationOutbox)).toEqual([]);
    await expect(drawer.getByRole("button", { name: /同步目标测试表/ })).toHaveCount(0);
    expect(fakeServer.sourceWrites).toEqual([]);
    expect(fakeServer.targetWrites).toEqual([]);

    for (const viewport of APPROVED_VIEWPORTS) {
      await page.setViewportSize(viewport);
      drawer = await openFeishuDrawer(page);
      await expect(drawer.getByText("飞书源货盘始终只读。", { exact: false })).toBeVisible();
      await expectCleanPage(
        page,
        failures,
        `/admin/system/integrations ${viewport.width}x${viewport.height}`,
      );
      await page.keyboard.press("Escape");
    }

    await page.context().clearCookies();
    await loginThroughUi(page, seededCustomer);
    await expect(page).toHaveURL(/\/portal/);
    await page.goto("/portal/catalog?q=TZX-001-1");

    const importedRow = page.locator('[data-testid^="catalog-"]:visible').first();
    await expect(importedRow).toContainText("TZX-001-1");
    await expect(importedRow).toContainText("可售");
    const image = importedRow.locator("img").first();
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    await expectCleanPage(page, failures, "/portal/catalog imported SKU");
  });

  test("ordinary admin only gets the read-only status view at mobile widths", async ({ page }) => {
    await resetMigrationBaseline(assetDir);
    fakeServer = new FakeFeishuServer(await buildValidSourceDataset());
    await fakeServer.listen();
    await runReadyPreflight(assetDir);

    const ordinaryAdmin = await createOrdinaryAdmin();
    await loginThroughUi(page, ordinaryAdmin);
    await expect(page).toHaveURL(/\/admin/);

    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const drawer = await openFeishuDrawer(page);
      await expect(
        drawer.getByText("飞书源货盘始终只读。", { exact: false }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("button", { name: "验证只读连接" }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("button", { name: "验证只读连接" }),
      ).toHaveJSProperty("disabled", false);
      await expect(
        drawer.getByRole("button", { name: "开始只读预检" }),
      ).toHaveCount(0);
      await expect(
        drawer.getByRole("button", { name: "确认迁移 140 个SKU" }),
      ).toHaveCount(0);
      await expect(
        drawer.getByRole("combobox", { name: "源工作表" }),
      ).toHaveCount(0);

      const detailButtons = drawer.getByRole("button", { name: "查看详情" });
      await expect(detailButtons.nth(0)).toHaveJSProperty("disabled", false);
      await expect(detailButtons.nth(1)).toHaveAttribute("aria-expanded", "false");

      const readOnlyButtonBox = await drawer
        .getByRole("button", { name: "验证只读连接" })
        .boundingBox();
      const detailsButtonBox = await drawer
        .getByRole("button", { name: "查看详情" })
        .first()
        .boundingBox();
      expect(readOnlyButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(detailsButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});
