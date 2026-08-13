import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  catalogAssets,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import { createCatalogAssetStorage } from "@/modules/feishu/asset-storage";
import {
  buildCargoSnapshot,
  syncCargoSnapshot,
  type FeishuCargoTargetPort,
} from "@/modules/feishu/cargo-sync";

async function createImageBuffer(input?: { b?: number; g?: number; r?: number }) {
  return await sharp({
    create: {
      background: {
        alpha: 1,
        b: input?.b ?? 117,
        g: input?.g ?? 80,
        r: input?.r ?? 32,
      },
      channels: 4,
      height: 9,
      width: 13,
    },
  })
    .png()
    .toBuffer();
}

async function seedCatalogAsset(input: {
  assetDir: string;
  fileName: string;
  runId: string;
  skuCode: string;
  tint: { b: number; g: number; r: number };
}) {
  const storage = createCatalogAssetStorage({ assetDir: input.assetDir });
  const bytes = await createImageBuffer(input.tint);
  const manifest = await storage.stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: input.fileName,
    runId: input.runId,
    skuCode: input.skuCode,
  });
  const storageKey = await storage.commitCatalogAsset(manifest);
  const [asset] = await db
    .insert(catalogAssets)
    .values({
      byteSize: manifest.byteSize,
      contentSha256: manifest.contentSha256,
      mimeType: manifest.mimeType,
      originalFileName: manifest.originalFileName,
      storageKey,
    })
    .returning({
      id: catalogAssets.id,
    });

  return { assetId: asset.id, bytes };
}

describe("Feishu cargo sheet sync", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        customers,
        catalog_assets
      restart identity cascade
    `));
  });

  test("builds the fixed target columns from database total and available inventory", async () => {
    const [product] = await db
      .insert(products)
      .values({ name: "宠物绳", description: "加拿大货盘" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        color: "黑色",
        combination: "10pcs/包",
        defaultUnitPriceFen: 293,
        name: "狗绳",
        productId: product.id,
        productUrl: "https://example.test/products/tzx-001",
        saleStatus: "SELLABLE",
        skuCode: "TZX-001-1",
        specification: "150*80",
        weightGrams: 218,
      })
      .returning();
    await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });
    await db.insert(inventoryReservations).values({
      quantity: 3,
      referenceId: "order-1",
      referenceType: "FULFILLMENT_ORDER",
      skuId: sku.id,
    });

    const snapshot = await buildCargoSnapshot();
    expect(snapshot).toEqual([
      [
        "序号",
        "SKU",
        "图片",
        "名称",
        "采购价",
        "总库存",
        "可售库存",
        "商品链接",
        "规格",
        "颜色",
        "组合销售",
        "重量",
        "状态",
      ],
      [
        1,
        "TZX-001-1",
        "",
        "狗绳",
        2.93,
        10,
        7,
        "https://example.test/products/tzx-001",
        "150*80",
        "黑色",
        "10pcs/包",
        "218g",
        "可售",
      ],
    ]);
  });

  test("writes target rows, clears stale data, uploads images serially, and applies target-only formatting", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "feishu-cargo-sync-"));
    const previousAssetDir = process.env.CATALOG_ASSET_DIR;
    process.env.CATALOG_ASSET_DIR = assetDir;

    try {
      const [productA] = await db.insert(products).values({ name: "Alpha Product" }).returning();
      const [productB] = await db.insert(products).values({ name: "Beta Product" }).returning();
      const firstAsset = await seedCatalogAsset({
        assetDir,
        fileName: "alpha-1.png",
        runId: "cargo-sync-a",
        skuCode: "ALPHA-001",
        tint: { b: 40, g: 60, r: 80 },
      });
      const secondAsset = await seedCatalogAsset({
        assetDir,
        fileName: "alpha-2.png",
        runId: "cargo-sync-b",
        skuCode: "ALPHA-002",
        tint: { b: 90, g: 110, r: 130 },
      });

      const [firstSku] = await db
        .insert(skus)
        .values({
          color: "Black",
          combination: "2pcs",
          defaultUnitPriceFen: 1999,
          imageAssetId: firstAsset.assetId,
          imageUrl: `/api/catalog-assets/${firstAsset.assetId}`,
          name: "Alpha Product / Small",
          productId: productA.id,
          productUrl: "https://example.test/products/alpha",
          saleStatus: "SELLABLE",
          skuCode: "ALPHA-001",
          specification: "Small",
          weightGrams: 120,
        })
        .returning();
      const [secondSku] = await db
        .insert(skus)
        .values({
          color: "White",
          combination: "4pcs",
          defaultUnitPriceFen: 2599,
          imageAssetId: secondAsset.assetId,
          imageUrl: `/api/catalog-assets/${secondAsset.assetId}`,
          name: "Alpha Product / Large",
          productId: productA.id,
          productUrl: "https://example.test/products/alpha",
          saleStatus: "NOT_SELLABLE",
          skuCode: "ALPHA-002",
          specification: "Large",
          weightGrams: 240,
        })
        .returning();
      const [thirdSku] = await db
        .insert(skus)
        .values({
          color: "Blue",
          combination: null,
          defaultUnitPriceFen: 3299,
          name: "Beta Product / Standard",
          productId: productB.id,
          productUrl: "https://example.test/products/beta",
          saleStatus: "SELLABLE",
          skuCode: "BETA-001",
          specification: "Standard",
          weightGrams: null,
        })
        .returning();

      await db.insert(inventoryBalances).values([
        { skuId: firstSku.id, totalQuantity: 9 },
        { skuId: secondSku.id, totalQuantity: 0 },
        { skuId: thirdSku.id, totalQuantity: 5 },
      ]);
      await db.insert(inventoryReservations).values({
        quantity: 2,
        referenceId: "order-2",
        referenceType: "FULFILLMENT_ORDER",
        skuId: firstSku.id,
      });

      const calls: string[] = [];
      let readRangeInput:
        | {
            range: string;
            spreadsheetToken: string;
          }
        | undefined;
      let written:
        | {
            range: string;
            spreadsheetToken: string;
            values: Array<Array<number | string | null>>;
          }
        | undefined;
      let activeImageWrites = 0;
      const imageWrites: Array<{
        bytes: Uint8Array;
        fileName: string;
        range: string;
        spreadsheetToken: string;
      }> = [];
      const dimensionUpdates: Array<{
        dimension: {
          endIndex: number;
          majorDimension: "COLUMNS" | "ROWS";
          sheetId: string;
          startIndex: number;
        };
        dimensionProperties: { fixedSize?: number; visible?: boolean };
        spreadsheetToken: string;
      }> = [];
      const styleUpdates: Array<{
        data: Array<{
          ranges: string[];
          style: Record<string, unknown>;
        }>;
        spreadsheetToken: string;
      }> = [];
      const filterUpdates: Array<{
        col: string;
        condition: { compare_type?: string; expected?: string[]; filter_type: string };
        range: string;
        sheetId: string;
        spreadsheetToken: string;
      }> = [];
      const sheetPropertyUpdates: Array<{
        properties: { frozenColCount?: number; frozenRowCount?: number; sheetId: string };
        spreadsheetToken: string;
      }> = [];

      const client: FeishuCargoTargetPort = {
        async createFilter(input) {
          calls.push("createFilter");
          filterUpdates.push(input);
        },
        async readRange(input) {
          calls.push("readRange");
          readRangeInput = input;
          return [["old-1"], ["old-2"], ["old-3"], ["old-4"], ["old-5"]];
        },
        async setRangeStyle(input) {
          calls.push("setRangeStyle");
          styleUpdates.push(input);
        },
        async updateDimension(input) {
          calls.push("updateDimension");
          dimensionUpdates.push(input);
        },
        async updateSheetProperties(input) {
          calls.push("updateSheetProperties");
          sheetPropertyUpdates.push(input);
        },
        async writeImage(input) {
          calls.push(`writeImage:${input.range}`);
          activeImageWrites += 1;
          expect(activeImageWrites).toBe(1);
          await Promise.resolve();
          imageWrites.push(input);
          activeImageWrites -= 1;
        },
        async writeRange(input) {
          calls.push("writeRange");
          written = input;
        },
      };

      const result = await syncCargoSnapshot({
        client,
        config: {
          sourceSpreadsheetToken: "source-spreadsheet-token",
          targetSheetId: "sheet-1",
          targetSpreadsheetToken: "target-spreadsheet-token",
        },
      });

      expect(result).toEqual({
        imageCount: 2,
        rowCount: 4,
        targetSheetId: "sheet-1",
      });
      expect(readRangeInput).toEqual({
        range: "sheet-1!A1:M5000",
        spreadsheetToken: "target-spreadsheet-token",
      });
      expect(written).toMatchObject({
        range: "sheet-1!A1:M5",
        spreadsheetToken: "target-spreadsheet-token",
      });
      expect(written?.values).toEqual([
        [
          "序号",
          "SKU",
          "图片",
          "名称",
          "采购价",
          "总库存",
          "可售库存",
          "商品链接",
          "规格",
          "颜色",
          "组合销售",
          "重量",
          "状态",
        ],
        [
          1,
          "ALPHA-001",
          "",
          "Alpha Product / Small",
          19.99,
          9,
          7,
          "https://example.test/products/alpha",
          "Small",
          "Black",
          "2pcs",
          "120g",
          "可售",
        ],
        [
          2,
          "ALPHA-002",
          "",
          "Alpha Product / Large",
          25.99,
          0,
          0,
          "https://example.test/products/alpha",
          "Large",
          "White",
          "4pcs",
          "240g",
          "不可售",
        ],
        [
          3,
          "BETA-001",
          "",
          "Beta Product / Standard",
          32.99,
          5,
          5,
          "https://example.test/products/beta",
          "Standard",
          "Blue",
          "",
          "",
          "可售",
        ],
        Array(13).fill(null),
      ]);
      expect(
        imageWrites.map((write) => ({
          ...write,
          bytes: Array.from(write.bytes),
        })),
      ).toEqual([
        {
          bytes: Array.from(firstAsset.bytes),
          fileName: "alpha-1.png",
          range: "sheet-1!C2:C2",
          spreadsheetToken: "target-spreadsheet-token",
        },
        {
          bytes: Array.from(secondAsset.bytes),
          fileName: "alpha-2.png",
          range: "sheet-1!C3:C3",
          spreadsheetToken: "target-spreadsheet-token",
        },
      ]);
      expect(styleUpdates).toEqual([
        {
          data: [
            {
              ranges: ["sheet-1!A1:M1"],
              style: expect.objectContaining({
                font: expect.objectContaining({ bold: true }),
                hAlign: 1,
              }),
            },
          ],
          spreadsheetToken: "target-spreadsheet-token",
        },
      ]);
      expect(sheetPropertyUpdates).toEqual([
        {
          properties: {
            frozenRowCount: 1,
            sheetId: "sheet-1",
          },
          spreadsheetToken: "target-spreadsheet-token",
        },
      ]);
      expect(filterUpdates).toEqual([
        {
          col: "A",
          condition: {
            compare_type: "notEqual",
            expected: [""],
            filter_type: "text",
          },
          range: "sheet-1!A1:M4",
          sheetId: "sheet-1",
          spreadsheetToken: "target-spreadsheet-token",
        },
      ]);
      expect(dimensionUpdates).toEqual([
        {
          dimension: {
            endIndex: 4,
            majorDimension: "ROWS",
            sheetId: "sheet-1",
            startIndex: 1,
          },
          dimensionProperties: { fixedSize: 120, visible: true },
          spreadsheetToken: "target-spreadsheet-token",
        },
        {
          dimension: {
            endIndex: 1,
            majorDimension: "COLUMNS",
            sheetId: "sheet-1",
            startIndex: 0,
          },
          dimensionProperties: { fixedSize: 80, visible: true },
          spreadsheetToken: "target-spreadsheet-token",
        },
        {
          dimension: {
            endIndex: 2,
            majorDimension: "COLUMNS",
            sheetId: "sheet-1",
            startIndex: 1,
          },
          dimensionProperties: { fixedSize: 140, visible: true },
          spreadsheetToken: "target-spreadsheet-token",
        },
        {
          dimension: {
            endIndex: 3,
            majorDimension: "COLUMNS",
            sheetId: "sheet-1",
            startIndex: 2,
          },
          dimensionProperties: { fixedSize: 160, visible: true },
          spreadsheetToken: "target-spreadsheet-token",
        },
      ]);
      expect(calls).toEqual([
        "readRange",
        "writeRange",
        "writeImage:sheet-1!C2:C2",
        "writeImage:sheet-1!C3:C3",
        "updateSheetProperties",
        "setRangeStyle",
        "updateDimension",
        "updateDimension",
        "updateDimension",
        "updateDimension",
        "createFilter",
      ]);
    } finally {
      if (previousAssetDir === undefined) {
        delete process.env.CATALOG_ASSET_DIR;
      } else {
        process.env.CATALOG_ASSET_DIR = previousAssetDir;
      }
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("rejects a target spreadsheet equal to the source before the first target read or write", async () => {
    const calls: string[] = [];
    const client: FeishuCargoTargetPort = {
      async createFilter() {
        calls.push("createFilter");
      },
      async readRange() {
        calls.push("readRange");
        return [];
      },
      async setRangeStyle() {
        calls.push("setRangeStyle");
      },
      async updateDimension() {
        calls.push("updateDimension");
      },
      async updateSheetProperties() {
        calls.push("updateSheetProperties");
      },
      async writeImage() {
        calls.push("writeImage");
      },
      async writeRange() {
        calls.push("writeRange");
      },
    };

    await expect(
      syncCargoSnapshot({
        client,
        config: {
          sourceSpreadsheetToken: "same-spreadsheet-token",
          targetSheetId: "sheet-1",
          targetSpreadsheetToken: "same-spreadsheet-token",
        },
      }),
    ).rejects.toThrowError("飞书源货盘与目标测试表不能是同一电子表格");
    expect(calls).toEqual([]);
  });
});
