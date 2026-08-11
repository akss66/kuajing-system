import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import {
  buildCargoSnapshot,
  syncCargoSnapshot,
  type FeishuCargoPort,
} from "@/modules/feishu/cargo-sync";

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
        customers
      restart identity cascade
    `));
  });

  test("builds the fixed cargo columns from database total and available inventory", async () => {
    const [product] = await db
      .insert(products)
      .values({ name: "头绳", description: "加拿大货盘" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        color: "黑色",
        combination: "10pcs/包",
        defaultUnitPriceFen: 293,
        imageUrl: "https://example.test/tzx-001.jpg",
        name: "狗绳",
        productId: product.id,
        productUrl: "https://example.test/products/tzx-001",
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
        "总库存(件)",
        "可售库存",
        "链接文字",
        "规格",
        "颜色",
        "组合销售",
        "重量",
        "状态",
      ],
      [
        1,
        "TZX-001-1",
        "https://example.test/tzx-001.jpg",
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

  test("resolves the wiki spreadsheet, keeps the selected sheet and clears stale trailing rows", async () => {
    const [product] = await db.insert(products).values({ name: "商品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 450,
        name: "厨房挂钩",
        productId: product.id,
        skuCode: "TZX-002",
      })
      .returning();
    await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 4 });
    let written:
      | { range: string; spreadsheetToken: string; values: Array<Array<number | string | null>> }
      | undefined;
    const client: FeishuCargoPort = {
      async listSheets() {
        return [{ index: 0, sheetId: "cargo-sheet", title: "加拿大货盘" }];
      },
      async readRange() {
        return [["序号"], [1], [2], [3]];
      },
      async resolveWikiSpreadsheet() {
        return { spreadsheetToken: "spreadsheet-token" };
      },
      async writeRange(input) {
        written = input;
      },
    };

    const result = await syncCargoSnapshot({
      client,
      config: { cargoWikiToken: "Mr9Pw5XgriFyIXkv8tzcZzIpnNb" },
    });

    expect(result).toEqual({ rowCount: 2, sheetId: "cargo-sheet", writtenRows: 4 });
    expect(written).toMatchObject({
      range: "cargo-sheet!A1:M4",
      spreadsheetToken: "spreadsheet-token",
    });
    expect(written?.values).toHaveLength(4);
    expect(written?.values[2]).toEqual(Array(13).fill(null));
    expect(written?.values[3]).toEqual(Array(13).fill(null));
  });
});
