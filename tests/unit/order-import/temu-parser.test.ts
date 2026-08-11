import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  classifyTemuRows,
  groupTemuRowsIntoShipments,
  parseTemuOrderWorkbook,
  TEMU_EXPORT_HEADERS,
} from "@/modules/order-import/temu-parser";

const baseRow: Record<(typeof TEMU_EXPORT_HEADERS)[number], string | number> = {
  订单号: "PO-10001",
  站点: "加拿大",
  订单状态: "待发货",
  子订单号: "SUB-10001-1",
  应履约件数: 1,
  商品名称: "匿名测试商品",
  SKUID: "SKUID-1",
  SKCID: "SKCID-1",
  SPUID: "SPUID-1",
  SKU货号: "STORE-SKU-BLACK",
  商品属性: "颜色：黑色",
  收货人姓名: "Test Recipient",
  收货人联系方式: "+1 613 555 0100",
  备用联系方式: "",
  邮箱: "recipient@example.test",
  身份证号: "",
  税号: "",
  详细地址1: "100 Example Street",
  详细地址2: "Unit 2",
  详细地址3: "",
  区县: "Ottawa",
  城市: "Ottawa",
  省份: "Ontario",
  收货地址邮编: "K1A 0B1",
  国家: "Canada",
  运单号: "",
  物流商: "",
  发货仓: "",
  订单创建时间: "2026-08-11 10:00:00",
  要求最晚发货时间: "2026-08-13 10:00:00",
  实际发货时间: "",
  预计送达时间: "",
  实际签收时间: "",
};

async function buildWorkbook(
  rows: Array<Partial<typeof baseRow>>,
  headers: readonly string[] = TEMU_EXPORT_HEADERS,
) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");
  worksheet.addRow([...headers]);

  for (const row of rows) {
    const values = { ...baseRow, ...row };
    worksheet.addRow(headers.map((header) => values[header as keyof typeof values] ?? ""));
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("TEMU order workbook parser", () => {
  it("parses the exact 33-column export and groups sub-orders into recipient shipments", async () => {
    const buffer = await buildWorkbook([
      {},
      {
        子订单号: "SUB-10001-2",
        SKU货号: "STORE-SKU-RED",
        商品属性: "颜色：红色",
      },
      {
        订单号: "PO-10002",
        子订单号: "SUB-10002-1",
        SKU货号: "STORE-SKU-UNKNOWN",
        收货人姓名: "Second Recipient",
        收货人联系方式: "+1 416 555 0100",
        详细地址1: "200 Example Road",
        城市: "Toronto",
        区县: "Toronto",
        省份: "Ontario",
        收货地址邮编: "M5V 3A8",
      },
    ]);

    const parsed = await parseTemuOrderWorkbook({
      buffer,
      fileName: "temu-orders.xlsx",
    });

    expect(parsed.rows).toHaveLength(3);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      externalOrderNo: "PO-10001",
      externalSubOrderNo: "SUB-10001-1",
      externalSku: "STORE-SKU-BLACK",
      quantity: 1,
    });

    const shipments = groupTemuRowsIntoShipments(parsed.rows);
    expect(shipments).toHaveLength(2);
    expect(shipments[0].externalOrderNo).toBe("PO-10001");
    expect(shipments[0].rows).toHaveLength(2);
    expect(shipments[1].rows).toHaveLength(1);
  });

  it("classifies ready, duplicate and unknown SKU rows without guessing aliases", async () => {
    const parsed = await parseTemuOrderWorkbook({
      buffer: await buildWorkbook([
        {},
        { 子订单号: "SUB-10001-2", SKU货号: "STORE-SKU-DUPLICATE" },
        { 子订单号: "SUB-10001-3", SKU货号: "STORE-SKU-UNKNOWN" },
      ]),
      fileName: "temu-orders.xlsx",
    });

    const classified = classifyTemuRows(parsed, {
      duplicateSubOrderNumbers: new Set(["SUB-10001-2"]),
      skuIdByExactAlias: new Map([["STORE-SKU-BLACK", "sku-internal-1"]]),
    });

    expect(classified.summary).toEqual({
      total: 3,
      ready: 1,
      duplicate: 1,
      unknownSku: 1,
      invalid: 0,
    });
    expect(classified.rows.map((row) => row.status)).toEqual([
      "READY",
      "DUPLICATE",
      "UNKNOWN_SKU",
    ]);
    expect(classified.rows[2].resolvedSkuId).toBeNull();
  });

  it("rejects changed headers, non-xlsx files and oversized input", async () => {
    const changedHeaders: string[] = [...TEMU_EXPORT_HEADERS];
    changedHeaders[9] = "商家SKU";

    await expect(
      parseTemuOrderWorkbook({
        buffer: await buildWorkbook([{}], changedHeaders),
        fileName: "temu-orders.xlsx",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_HEADERS",
    });

    await expect(
      parseTemuOrderWorkbook({ buffer: Buffer.from("csv"), fileName: "orders.csv" }),
    ).rejects.toMatchObject({
      code: "INVALID_FILE_TYPE",
    });

    await expect(
      parseTemuOrderWorkbook({
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
        fileName: "orders.xlsx",
      }),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("reports invalid rows without echoing names, phones or addresses", async () => {
    const sensitiveName = "Do Not Leak Name";
    const sensitivePhone = "+1 999 555 0199";
    const sensitiveAddress = "999 Secret Street";
    const parsed = await parseTemuOrderWorkbook({
      buffer: await buildWorkbook([
        {
          应履约件数: 0,
          收货人姓名: sensitiveName,
          收货人联系方式: sensitivePhone,
          详细地址1: sensitiveAddress,
        },
      ]),
      fileName: "temu-orders.xlsx",
    });

    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toHaveLength(1);
    const serializedIssues = JSON.stringify(parsed.issues);
    expect(serializedIssues).not.toContain(sensitiveName);
    expect(serializedIssues).not.toContain(sensitivePhone);
    expect(serializedIssues).not.toContain(sensitiveAddress);
    expect(parsed.issues[0]).toMatchObject({
      rowNumber: 2,
      code: "INVALID_QUANTITY",
    });
  });
});
