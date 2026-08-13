import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db/client";
import { seed } from "@/db/seed";
import {
  adminUsers,
  authUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  integrationOutbox,
  products,
  skus,
} from "@/db/schema";
import { FeishuClient } from "@/integrations/feishu/client";
import { syncCargoSnapshot } from "@/modules/feishu/cargo-sync";
import { createFeishuCargoMigrationService } from "@/modules/feishu/migration-service";

import { createManagedUser, loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const FEISHU_PORT = 4010;
const FEISHU_BASE_URL = `http://127.0.0.1:${FEISHU_PORT}`;
const SOURCE_WIKI_TOKEN = "wiki-source-token";
const SOURCE_SPREADSHEET_TOKEN = "source-spreadsheet-token";
const TARGET_SPREADSHEET_TOKEN = "target-spreadsheet-token";
const TARGET_SHEET_ID = "target-sheet-id";

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
  readonly targetWrites: FakeWriteRecord[] = [];
  readonly sourceWrites: FakeWriteRecord[] = [];

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

    if (method === "GET" && path === `/open-apis/sheets/v3/spreadsheets/${SOURCE_SPREADSHEET_TOKEN}/sheets/query`) {
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

    if (method === "GET" && path === `/open-apis/sheets/v3/spreadsheets/${TARGET_SPREADSHEET_TOKEN}/sheets/query`) {
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

function buildRow(input: {
  color: string;
  combination: string;
  groupKey: string;
  priceYuan: string;
  productName: string;
  productUrl: string;
  quantity: number;
  skuCode: string;
  specification: string;
  weight: string;
}) {
  return [
    input.groupKey,
    input.skuCode,
    {
      fileToken: `file-token-${input.skuCode}`,
      text: `Image ${input.skuCode}`,
    },
    input.productName,
    input.priceYuan,
    String(input.quantity),
    "可售",
    input.productUrl,
    input.specification,
    input.color,
    input.combination,
    input.weight,
  ];
}

async function buildValidSourceDataset() {
  const downloads = new Map<string, DownloadRecord>();
  const values: unknown[][] = [[
    "序号",
    "sku",
    "图片",
    "名称",
    "采购价",
    "总库存",
    "状态",
    "链接文字",
    "规格",
    "颜色",
    "组合销售",
    "重量",
  ]];

  for (let index = 1; index <= 74; index += 1) {
    const groupNumber = index <= 50 ? index : index - 50;
    const skuCode = `SKU-${String(index).padStart(3, "0")}`;
    values.push(
      buildRow({
        color: `Color ${index}`,
        combination: `Combo ${index}`,
        groupKey: `GROUP-${String(groupNumber).padStart(3, "0")}`,
        priceYuan: `${10 + index}.50`,
        productName: index === 1 ? "迁移测试商品 1" : `迁移测试商品 ${groupNumber}`,
        productUrl: `https://example.test/products/${groupNumber}`,
        quantity: index % 6 === 0 ? 0 : (index % 9) + 1,
        skuCode,
        specification: `Spec ${index}`,
        weight: `${100 + index}g`,
      }),
    );
    downloads.set(`file-token-${skuCode}`, {
      bytes: await createImageBuffer(index),
      contentType: "image/png",
      fileName: `${skuCode}.png`,
    });
  }

  return { downloads, values } satisfies FakeFeishuDataset;
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
  const assetDir = resolve(process.cwd(), process.env.CATALOG_ASSET_DIR ?? ".e2e-catalog-assets");

  test.beforeEach(async () => {
    process.env.CATALOG_ASSET_DIR = assetDir;
  });

  test.afterEach(async () => {
    if (fakeServer) {
      await fakeServer.close();
      fakeServer = null;
    }
  });

  test("super admin preflights 74 SKU, confirms import, and syncs only the target sheet", async ({ page }) => {
    await resetMigrationBaseline(assetDir);
    fakeServer = new FakeFeishuServer(await buildValidSourceDataset());
    await fakeServer.listen();

    await loginThroughUi(page, seededSuperAdmin);
    await expect(page).toHaveURL(/\/admin/);

    let drawer = await openFeishuDrawer(page);
    await drawer.getByRole("button", { name: "开始只读预检" }).click();
    await expect(
      drawer.getByText("源货盘包含多个工作表，请先选择本次预检的源工作表。"),
    ).toBeVisible();
    await drawer.getByRole("combobox", { name: "源工作表" }).selectOption("sheet-source-a");
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
      drawer.getByRole("button", { name: "确认迁移 74 个 SKU" }),
    ).toBeVisible();
    await drawer.getByLabel("确认语句").fill("确认迁移74个SKU");
    await drawer.getByRole("button", { name: "确认迁移 74 个 SKU" }).click();
    const confirmDialog = page.getByRole("alertdialog", {
      name: "确认导入 74 个 SKU",
    });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "确认导入 74 个 SKU" }).click();
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
    expect(productCountRow?.count).toBe(50);
    expect(skuCountRow?.count).toBe(74);
    expect(assetCountRow?.count).toBe(74);

    await drawer.getByRole("button", { name: "重试目标同步" }).click();
    await expect(
      drawer.getByText("目标测试表同步已加入队列，后台任务会继续重试。"),
    ).toBeVisible();

    const [queuedSyncEvent] = await db
      .select({
        payload: integrationOutbox.payload,
        status: integrationOutbox.status,
      })
      .from(integrationOutbox)
      .where(eq(integrationOutbox.eventType, "FEISHU_CARGO_SYNC"))
      .orderBy(sql`${integrationOutbox.updatedAt} desc`)
      .limit(1);
    expect(queuedSyncEvent).toMatchObject({
      payload: { reason: "administrator-manual-sync" },
      status: expect.stringMatching(/^(PENDING|FAILED)$/),
    });

    await syncCargoSnapshot({
      client: new FeishuClient({
        appId: "e2e-feishu-app-id",
        appSecret: "e2e-feishu-app-secret",
        baseUrl: FEISHU_BASE_URL,
      }),
      config: {
        sourceSpreadsheetToken: SOURCE_SPREADSHEET_TOKEN,
        targetSheetId: TARGET_SHEET_ID,
        targetSpreadsheetToken: TARGET_SPREADSHEET_TOKEN,
      },
    });

    expect(fakeServer.sourceWrites).toEqual([]);
    expect(fakeServer.targetWrites.length).toBeGreaterThan(0);
    expect(
      fakeServer.targetWrites.every(
        (write) => write.spreadsheetToken === TARGET_SPREADSHEET_TOKEN,
      ),
    ).toBe(true);

    await page.context().clearCookies();
    await loginThroughUi(page, seededCustomer);
    await expect(page).toHaveURL(/\/portal/);
    await page.goto("/portal/catalog?q=SKU-001");

    const importedRow = page.locator('[data-testid^="catalog-"]:visible').first();
    await expect(importedRow).toContainText("SKU-001");
    await expect(importedRow).toContainText("可售");
    const image = importedRow.locator("img").first();
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((item) =>
        ["serious", "critical"].includes(item.impact ?? ""),
      ),
    ).toEqual([]);
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
      await expect(drawer.getByText("原业务货盘受保护，系统不会写入。")).toBeVisible();
      await expect(
        drawer.getByRole("button", { name: "验证只读连接" }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("button", { name: "重试目标同步" }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("button", { name: "验证只读连接" }),
      ).toHaveJSProperty("disabled", false);
      await expect(
        drawer.getByRole("button", { name: "重试目标同步" }),
      ).toHaveJSProperty("disabled", false);
      await expect(
        drawer.getByRole("button", { name: "开始只读预检" }),
      ).toHaveCount(0);
      await expect(
        drawer.getByRole("button", { name: "确认迁移 74 个 SKU" }),
      ).toHaveCount(0);

      const readOnlyButtonBox = await drawer
        .getByRole("button", { name: "验证只读连接" })
        .boundingBox();
      const retryButtonBox = await drawer
        .getByRole("button", { name: "重试目标同步" })
        .boundingBox();
      expect(readOnlyButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(retryButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});
