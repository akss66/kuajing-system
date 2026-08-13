import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import { db } from "@/db/client";
import { FeishuApiError } from "@/integrations/feishu/client";
import type { FeishuIntegrationConfig } from "@/integrations/feishu/config";
import { authUsers, feishuCargoMigrationRuns } from "@/db/schema";
import {
  createFeishuCargoMigrationService,
} from "@/modules/feishu/migration-service";
import type { FeishuSourcePort } from "@/modules/feishu/source-reader";

const HEADER_ROW = [
  "\u5e8f\u53f7",
  "sku",
  "\u56fe\u7247",
  "\u540d\u79f0",
  "\u91c7\u8d2d\u4ef7",
  "\u603b\u5e93\u5b58",
  "\u72b6\u6001",
  "\u94fe\u63a5\u6587\u5b57",
  "\u89c4\u683c",
  "\u989c\u8272",
  "\u7ec4\u5408\u9500\u552e",
  "\u91cd\u91cf",
] as const;

type SourceRowInput = {
  color: string;
  combination: string;
  groupKey: string;
  priceYuan: string;
  productName: string;
  productUrl: string;
  quantity: number;
  skuCode: string;
  specification: string;
  status?: "SELLABLE" | "NOT_SELLABLE";
  weight: string;
};

type DownloadRecord = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
};

function createConfig(input?: Partial<FeishuIntegrationConfig>): FeishuIntegrationConfig {
  return {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    sourceSheetId: "sheet-primary",
    sourceWikiToken: "wiki-source-token",
    targetSheetId: "target-sheet",
    targetSpreadsheetToken: "target-spreadsheet-token",
    ...input,
  };
}

async function createImageBuffer(seed: number) {
  return await sharp({
    create: {
      background: {
        alpha: 1,
        b: (seed * 47) % 255,
        g: (seed * 29) % 255,
        r: (seed * 13) % 255,
      },
      channels: 4,
      height: 12,
      width: 12,
    },
  })
    .png()
    .toBuffer();
}

function buildSourceRow(input: SourceRowInput) {
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
    input.status === "NOT_SELLABLE" ? "\u4e0d\u53ef\u552e" : "\u53ef\u552e",
    input.productUrl,
    input.specification,
    input.color,
    input.combination,
    input.weight,
  ];
}

async function buildValidSourceValues(rowCount = 74) {
  const downloads = new Map<string, DownloadRecord>();
  const values: unknown[][] = [Array.from(HEADER_ROW)];

  for (let index = 1; index <= rowCount; index += 1) {
    const groupNumber = index <= 50 ? index : index - 50;
    const skuCode = `SKU-${String(index).padStart(3, "0")}`;
    values.push(
      buildSourceRow({
        color: `Color ${index}`,
        combination: `Combo ${index}`,
        groupKey: `GROUP-${String(groupNumber).padStart(3, "0")}`,
        priceYuan: `${10 + index}.50`,
        productName: `Product ${groupNumber}`,
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

  return { downloads, values };
}

async function createSuperAdminActor() {
  const userId = crypto.randomUUID();
  const email = `super-admin-${userId}@example.test`;

  await db.insert(authUsers).values({
    banned: false,
    email,
    id: userId,
    name: "Source Protection Super Admin",
    role: "super_admin",
  });
  await db.execute(sql`
    insert into admin_users (id, login_identifier, display_name, status)
    values (${crypto.randomUUID()}::uuid, ${email}, 'Source Protection Mirror', 'ACTIVE')
  `);

  return { kind: "SUPER_ADMIN" as const, userId };
}

function createFakeSourceClient(input: {
  downloads: Map<string, DownloadRecord>;
  revision?: number;
  sheets?: Array<{ index: number; sheetId: string; title: string }>;
  spreadsheetToken?: string;
  values: unknown[][];
}) {
  const calls = {
    createFilter: 0,
    downloadMedia: [] as string[],
    listSheets: 0,
    readRangeDetails: [] as Array<{ range: string; spreadsheetToken: string }>,
    resolveWikiSpreadsheet: 0,
    sendTextMessage: 0,
    setRangeStyle: 0,
    updateDimension: 0,
    writeImage: 0,
    writeRange: 0,
  };

  const spreadsheetToken = input.spreadsheetToken ?? "source-spreadsheet-token";
  const sheets =
    input.sheets ?? [{ index: 0, sheetId: "sheet-primary", title: "Primary source sheet" }];
  const revision = input.revision ?? 9;

  const client = {
    async createFilter() {
      calls.createFilter += 1;
      throw new Error("source preflight must stay read-only");
    },
    async downloadMedia(fileToken: string) {
      calls.downloadMedia.push(fileToken);
      const record = input.downloads.get(fileToken);
      if (!record) {
        throw new FeishuApiError("HTTP_404", "not found", false);
      }
      return record;
    },
    async listSheets() {
      calls.listSheets += 1;
      return sheets;
    },
    async readRangeDetails(readInput: { range: string; spreadsheetToken: string }) {
      calls.readRangeDetails.push(readInput);
      return {
        range: readInput.range,
        revision,
        values: input.values,
      };
    },
    async resolveWikiSpreadsheet() {
      calls.resolveWikiSpreadsheet += 1;
      return { spreadsheetToken };
    },
    async sendTextMessage() {
      calls.sendTextMessage += 1;
      throw new Error("source preflight must stay read-only");
    },
    async setRangeStyle() {
      calls.setRangeStyle += 1;
      throw new Error("source preflight must stay read-only");
    },
    async updateDimension() {
      calls.updateDimension += 1;
      throw new Error("source preflight must stay read-only");
    },
    async writeImage() {
      calls.writeImage += 1;
      throw new Error("source preflight must stay read-only");
    },
    async writeRange() {
      calls.writeRange += 1;
      throw new Error("source preflight must stay read-only");
    },
  };

  return { calls, client };
}

describe("Feishu source preflight protection", () => {
  let assetRoot = "";

  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        feishu_cargo_migration_runs,
        integration_attempts,
        integration_outbox,
        audit_logs,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        catalog_assets,
        sku_aliases,
        customer_sku_prices,
        auth_sessions,
        auth_accounts,
        auth_verifications,
        auth_users,
        customer_users,
        admin_users,
        skus,
        products,
        customers
      restart identity cascade
    `));
    if (assetRoot) {
      await rm(assetRoot, { force: true, recursive: true });
      assetRoot = "";
    }
  });

  test("defines a read-only source port and persists only sanitized preflight data", async () => {
    expectTypeOf<FeishuSourcePort>().toMatchTypeOf<{
      downloadMedia: (...args: never[]) => Promise<unknown>;
      listSheets: (...args: never[]) => Promise<unknown>;
      readRangeDetails: (...args: never[]) => Promise<unknown>;
      resolveWikiSpreadsheet: (...args: never[]) => Promise<unknown>;
    }>();
    expectTypeOf<FeishuSourcePort>().not.toMatchTypeOf<{
      writeImage: (...args: never[]) => Promise<unknown>;
      writeRange: (...args: never[]) => Promise<unknown>;
    }>();

    assetRoot = await mkdtemp(join(tmpdir(), "feishu-source-protection-"));
    const actor = await createSuperAdminActor();
    const dataset = await buildValidSourceValues();
    const fake = createFakeSourceClient({
      downloads: dataset.downloads,
      values: dataset.values,
    });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = await service.createCargoPreflight({
      actor,
      client: fake.client as FeishuSourcePort,
      config: createConfig(),
    });

    expect(result.status).toBe("PREFLIGHT_READY");
    if (result.status !== "PREFLIGHT_READY") {
      throw new Error("expected preflight ready");
    }

    expect(fake.calls.resolveWikiSpreadsheet).toBe(1);
    expect(fake.calls.listSheets).toBe(1);
    expect(fake.calls.readRangeDetails).toEqual([
      {
        range: "sheet-primary!A1:Z500",
        spreadsheetToken: "source-spreadsheet-token",
      },
    ]);
    expect(fake.calls.downloadMedia).toHaveLength(74);
    expect(fake.calls.writeRange).toBe(0);
    expect(fake.calls.writeImage).toBe(0);
    expect(fake.calls.setRangeStyle).toBe(0);
    expect(fake.calls.updateDimension).toBe(0);
    expect(fake.calls.createFilter).toBe(0);
    expect(fake.calls.sendTextMessage).toBe(0);

    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, result.runId))
      .limit(1);

    expect(run?.status).toBe("PREFLIGHT_READY");
    expect(run?.temporaryAssetsJson).toHaveLength(74);
    expect(JSON.stringify(run)).not.toContain("file-token-");
    expect(JSON.stringify(run)).not.toContain("imageFileToken");
    expect(JSON.stringify(run)).not.toContain("downloadURL");
    expect(JSON.stringify(run)).not.toContain("source-spreadsheet-token");
    expect(run?.sourceSpreadsheetHash).toBe(
      createHash("sha256").update("source-spreadsheet-token").digest("hex"),
    );

    const firstStagedKey = run?.temporaryAssetsJson[0]?.temporaryKey;
    expect(firstStagedKey).toBeDefined();
    expect(await readFile(join(assetRoot, firstStagedKey as string))).toBeDefined();
  });

  test("requires explicit source sheet selection when the source spreadsheet has multiple sheets", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "feishu-source-selection-"));
    const actor = await createSuperAdminActor();
    const dataset = await buildValidSourceValues(1);
    const fake = createFakeSourceClient({
      downloads: dataset.downloads,
      sheets: [
        { index: 0, sheetId: "sheet-a", title: "Sheet A" },
        { index: 1, sheetId: "sheet-b", title: "Sheet B" },
      ],
      values: dataset.values,
    });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = await service.createCargoPreflight({
      actor,
      client: fake.client as FeishuSourcePort,
      config: createConfig({ sourceSheetId: undefined }),
    });

    expect(result).toEqual({
      sheetOptions: [
        { index: 0, sheetId: "sheet-a", title: "Sheet A" },
        { index: 1, sheetId: "sheet-b", title: "Sheet B" },
      ],
      status: "SOURCE_SHEET_SELECTION_REQUIRED",
    });
    expect(fake.calls.readRangeDetails).toEqual([]);
    expect(fake.calls.downloadMedia).toEqual([]);
    expect(fake.calls.writeRange).toBe(0);
    expect(await db.select().from(feishuCargoMigrationRuns)).toEqual([]);
  });
});
