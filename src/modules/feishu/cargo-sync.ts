import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { inventoryBalances, inventoryReservations, skus } from "@/db/schema";

type CargoCell = number | string | null;

export type FeishuCargoPort = {
  listSheets(spreadsheetToken: string): Promise<
    Array<{ index: number; sheetId: string; title: string }>
  >;
  readRange(input: {
    range: string;
    spreadsheetToken: string;
  }): Promise<unknown[][]>;
  resolveWikiSpreadsheet(
    wikiToken: string,
  ): Promise<{ spreadsheetToken: string }>;
  writeRange(input: {
    range: string;
    spreadsheetToken: string;
    values: CargoCell[][];
  }): Promise<unknown>;
};

export const CARGO_HEADERS = [
  "序号",
  "SKU",
  "图片",
  "名称",
  "采购价",
  "总库存(件)",
  "可售库存",
  "链接文字",
  "规格",
  "颜色",
  "组合销售",
  "重量",
  "状态",
] as const;

export async function buildCargoSnapshot(): Promise<CargoCell[][]> {
  const rows = await db
    .select({
      color: skus.color,
      combination: skus.combination,
      imageUrl: skus.imageUrl,
      name: skus.name,
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
    .innerJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .orderBy(asc(skus.skuCode));
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
  const reserved = new Map(
    reservedRows.map((row) => [row.skuId, row.quantity]),
  );

  return [
    [...CARGO_HEADERS],
    ...rows.map((row, index): CargoCell[] => {
      const available = row.totalQuantity - (reserved.get(row.skuId) ?? 0);
      return [
        index + 1,
        row.skuCode,
        row.imageUrl ?? "",
        row.name,
        row.unitPriceFen / 100,
        row.totalQuantity,
        available,
        row.productUrl ?? "",
        row.specification ?? "",
        row.color ?? "",
        row.combination ?? "",
        row.weightGrams === null ? "" : `${row.weightGrams}g`,
        row.saleStatus === "SELLABLE" && available > 0 ? "可售" : "不可售",
      ];
    }),
  ];
}

export async function syncCargoSnapshot(input: {
  client: FeishuCargoPort;
  config: { cargoSheetId?: string; cargoWikiToken: string };
}) {
  const { spreadsheetToken } = await input.client.resolveWikiSpreadsheet(
    input.config.cargoWikiToken,
  );
  const sheets = await input.client.listSheets(spreadsheetToken);
  const sheet = input.config.cargoSheetId
    ? sheets.find((candidate) => candidate.sheetId === input.config.cargoSheetId)
    : [...sheets].sort((a, b) => a.index - b.index)[0];
  if (!sheet) throw new Error("未找到配置的飞书货盘工作表");

  const snapshot = await buildCargoSnapshot();
  const existing = await input.client.readRange({
    range: `${sheet.sheetId}!A1:A5000`,
    spreadsheetToken,
  });
  const writtenRows = Math.max(snapshot.length, existing.length, 1);
  const values = [...snapshot];
  while (values.length < writtenRows) values.push(Array(13).fill(null));
  await input.client.writeRange({
    range: `${sheet.sheetId}!A1:M${writtenRows}`,
    spreadsheetToken,
    values,
  });
  return { rowCount: snapshot.length, sheetId: sheet.sheetId, writtenRows };
}
