import { asc, eq, sql } from "drizzle-orm";

import { assertSafeCargoTarget } from "@/integrations/feishu/config";
import { db } from "@/db/client";
import {
  catalogAssets,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";

import { openCatalogAsset } from "./asset-storage";

type CargoCell = number | string | null;

type CargoSnapshotRow = {
  availableQuantity: number;
  color: null | string;
  combination: null | string;
  imageAssetId: null | string;
  imageStorageKey: null | string;
  imageFileName: null | string;
  name: string;
  productUrl: null | string;
  saleStatus: "NOT_SELLABLE" | "SELLABLE";
  skuCode: string;
  specification: null | string;
  totalQuantity: number;
  unitPriceFen: number;
  weightGrams: null | number;
};

type CargoImageWrite = {
  bytes: Uint8Array;
  fileName: string;
  rowNumber: number;
};

export type FeishuSheetProperties = {
  frozenColCount?: number;
  frozenRowCount?: number;
  sheetId: string;
};

export type FeishuCargoTargetPort = {
  createFilter(input: {
    col: string;
    condition: {
      compare_type?: string;
      expected?: string[];
      filter_type: string;
    };
    range: string;
    sheetId: string;
    spreadsheetToken: string;
  }): Promise<unknown>;
  readRange(input: {
    range: string;
    spreadsheetToken: string;
  }): Promise<unknown[][]>;
  setRangeStyle(input: {
    data: Array<{
      ranges: string[];
      style: Record<string, unknown>;
    }>;
    spreadsheetToken: string;
  }): Promise<unknown>;
  updateDimension(input: {
    dimension: {
      endIndex: number;
      majorDimension: "COLUMNS" | "ROWS";
      sheetId: string;
      startIndex: number;
    };
    dimensionProperties: {
      fixedSize?: number;
      visible?: boolean;
    };
    spreadsheetToken: string;
  }): Promise<unknown>;
  updateSheetProperties(input: {
    properties: FeishuSheetProperties;
    spreadsheetToken: string;
  }): Promise<unknown>;
  writeImage(input: {
    bytes: Uint8Array;
    fileName: string;
    range: string;
    spreadsheetToken: string;
  }): Promise<unknown>;
  writeRange(input: {
    range: string;
    spreadsheetToken: string;
    values: CargoCell[][];
  }): Promise<unknown>;
};

type FeishuCargoSyncConfig = {
  sourceSpreadsheetToken: string;
  targetSheetId: string;
  targetSpreadsheetToken: string;
};

export class FeishuCargoSyncError extends Error {
  constructor(
    public readonly code:
      | "FEISHU_CARGO_TARGET_COLLISION"
      | "FEISHU_CARGO_TARGET_CONFIG"
      | "FEISHU_CARGO_TARGET_IMAGE_MISSING",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FeishuCargoSyncError";
  }
}

export const CARGO_HEADERS = [
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
] as const;

async function loadCargoSnapshotRows(): Promise<CargoSnapshotRow[]> {
  const rows = await db
    .select({
      color: skus.color,
      combination: skus.combination,
      imageAssetId: skus.imageAssetId,
      imageFileName: catalogAssets.originalFileName,
      imageStorageKey: catalogAssets.storageKey,
      name: skus.name,
      productName: products.name,
      productUrl: skus.productUrl,
      saleStatus: skus.saleStatus,
      skuCode: skus.skuCode,
      skuId: skus.id,
      specification: skus.specification,
      totalQuantity: inventoryBalances.totalQuantity,
      unitPriceFen: skus.defaultUnitPriceFen,
      weightGrams: skus.weightGrams,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .innerJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(catalogAssets, eq(catalogAssets.id, skus.imageAssetId))
    .orderBy(asc(products.name), asc(skus.skuCode));
  const reservedRows = await db
    .select({
      quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(
        Number,
      ),
      skuId: inventoryReservations.skuId,
    })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.status, "ACTIVE"))
    .groupBy(inventoryReservations.skuId);
  const reserved = new Map(reservedRows.map((row) => [row.skuId, row.quantity]));

  return rows.map((row) => ({
    availableQuantity: row.totalQuantity - (reserved.get(row.skuId) ?? 0),
    color: row.color,
    combination: row.combination,
    imageAssetId: row.imageAssetId,
    imageFileName: row.imageFileName,
    imageStorageKey: row.imageStorageKey,
    name: row.name,
    productUrl: row.productUrl,
    saleStatus: row.saleStatus,
    skuCode: row.skuCode,
    specification: row.specification,
    totalQuantity: row.totalQuantity,
    unitPriceFen: row.unitPriceFen,
    weightGrams: row.weightGrams,
  }));
}

function toSnapshotValueRows(rows: CargoSnapshotRow[]): CargoCell[][] {
  return [
    [...CARGO_HEADERS],
    ...rows.map((row, index): CargoCell[] => [
      index + 1,
      row.skuCode,
      "",
      row.name,
      row.unitPriceFen / 100,
      row.totalQuantity,
      row.availableQuantity,
      row.productUrl ?? "",
      row.specification ?? "",
      row.color ?? "",
      row.combination ?? "",
      row.weightGrams === null ? "" : `${row.weightGrams}g`,
      row.saleStatus === "SELLABLE" && row.availableQuantity > 0 ? "可售" : "不可售",
    ]),
  ];
}

async function buildCargoImageWrites(
  rows: CargoSnapshotRow[],
): Promise<CargoImageWrite[]> {
  const writes: CargoImageWrite[] = [];

  for (const [index, row] of rows.entries()) {
    if (!row.imageAssetId || !row.imageStorageKey) {
      continue;
    }
    const opened = await openCatalogAsset(row.imageStorageKey);
    writes.push({
      bytes: opened.bytes,
      fileName: row.imageFileName ?? `${row.skuCode}.png`,
      rowNumber: index + 2,
    });
  }

  return writes;
}

function throwTypedCargoSyncError(error: unknown): never {
  if (!(error instanceof Error)) {
    throw error;
  }

  if (error.message === "飞书集成配置不完整，请检查服务端环境变量") {
    throw new FeishuCargoSyncError(
      "FEISHU_CARGO_TARGET_CONFIG",
      error.message,
      false,
    );
  }

  if (error.message === "飞书源货盘与目标测试表不能是同一电子表格") {
    throw new FeishuCargoSyncError(
      "FEISHU_CARGO_TARGET_COLLISION",
      error.message,
      false,
    );
  }

  throw error;
}

function assertWritableCargoTarget(config: FeishuCargoSyncConfig) {
  try {
    assertSafeCargoTarget(
      {
        appId: "unused",
        appSecret: "unused",
        cargoImportEnabled: false,
        cargoWritesEnabled: true,
        sourceWikiToken: "unused",
        targetSheetId: config.targetSheetId,
        targetSpreadsheetToken: config.targetSpreadsheetToken,
      },
      config.sourceSpreadsheetToken,
    );
  } catch (error) {
    throwTypedCargoSyncError(error);
  }
}

export async function buildCargoSnapshot(): Promise<CargoCell[][]> {
  return toSnapshotValueRows(await loadCargoSnapshotRows());
}

export async function syncCargoSnapshot(input: {
  client: FeishuCargoTargetPort;
  config: FeishuCargoSyncConfig;
}) {
  const rows = await loadCargoSnapshotRows();
  const snapshot = toSnapshotValueRows(rows);
  const imageWrites = await buildCargoImageWrites(rows);
  const targetSpreadsheetToken = input.config.targetSpreadsheetToken;
  const targetSheetId = input.config.targetSheetId;
  const targetRange = `${targetSheetId}!A1:M5000`;
  assertWritableCargoTarget(input.config);
  const existing = await input.client.readRange({
    range: targetRange,
    spreadsheetToken: targetSpreadsheetToken,
  });

  const writtenRows = Math.max(snapshot.length, existing.length, 1);
  const values = [...snapshot];
  while (values.length < writtenRows) {
    values.push(Array(CARGO_HEADERS.length).fill(null));
  }

  assertWritableCargoTarget(input.config);
  await input.client.writeRange({
    range: `${targetSheetId}!A1:M${writtenRows}`,
    spreadsheetToken: targetSpreadsheetToken,
    values,
  });

  for (const imageWrite of imageWrites) {
    assertWritableCargoTarget(input.config);
    await input.client.writeImage({
      bytes: imageWrite.bytes,
      fileName: imageWrite.fileName,
      range: `${targetSheetId}!C${imageWrite.rowNumber}:C${imageWrite.rowNumber}`,
      spreadsheetToken: targetSpreadsheetToken,
    });
  }

  assertWritableCargoTarget(input.config);
  await input.client.updateSheetProperties({
    properties: {
      frozenRowCount: 1,
      sheetId: targetSheetId,
    },
    spreadsheetToken: targetSpreadsheetToken,
  });

  assertWritableCargoTarget(input.config);
  await input.client.setRangeStyle({
    data: [
      {
        ranges: [`${targetSheetId}!A1:M1`],
        style: {
          font: { bold: true },
          hAlign: 1,
        },
      },
    ],
    spreadsheetToken: targetSpreadsheetToken,
  });

  if (snapshot.length > 1) {
    assertWritableCargoTarget(input.config);
    await input.client.updateDimension({
      dimension: {
        endIndex: snapshot.length,
        majorDimension: "ROWS",
        sheetId: targetSheetId,
        startIndex: 1,
      },
      dimensionProperties: { fixedSize: 120, visible: true },
      spreadsheetToken: targetSpreadsheetToken,
    });
  }

  const columnWidths = [80, 140, 160] as const;
  for (const [index, width] of columnWidths.entries()) {
    assertWritableCargoTarget(input.config);
    await input.client.updateDimension({
      dimension: {
        endIndex: index + 1,
        majorDimension: "COLUMNS",
        sheetId: targetSheetId,
        startIndex: index,
      },
      dimensionProperties: { fixedSize: width, visible: true },
      spreadsheetToken: targetSpreadsheetToken,
    });
  }

  assertWritableCargoTarget(input.config);
  await input.client.createFilter({
    col: "A",
    condition: {
      compare_type: "notEqual",
      expected: [""],
      filter_type: "text",
    },
    range: `${targetSheetId}!A1:M${Math.max(snapshot.length, 1)}`,
    sheetId: targetSheetId,
    spreadsheetToken: targetSpreadsheetToken,
  });

  return {
    imageCount: imageWrites.length,
    rowCount: snapshot.length,
    targetSheetId,
  };
}
