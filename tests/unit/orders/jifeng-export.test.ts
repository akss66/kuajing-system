import ExcelJS from "exceljs";
import { describe, expect, test } from "vitest";

import {
  buildJifengExportWorkbook,
  JIFENG_EXPORT_HEADERS,
} from "@/modules/orders/jifeng-export";

const expectedHeaders = [
  "订单号",
  "个人姓名",
  "店铺名称",
  "商品中文名称",
  "SKU货号",
  "应履约件数",
  "申报单价",
  "收件人姓名",
  "收件人电话",
  "收件人城市",
  "收件人省/州",
  "收件人邮编",
  "收件人国家",
  "详细地址1",
  "详细地址2",
  "物流产品(产品编号)",
] as const;

describe("Jifeng manual shipment workbook", () => {
  test("matches the supplied 16-column template and emits one row per shipment line", async () => {
    expect(JIFENG_EXPORT_HEADERS).toEqual(expectedHeaders);

    const bytes = await buildJifengExportWorkbook([
      {
        addressLine1: "100 Main St",
        addressLine2: "Unit 8",
        city: "Ottawa",
        country: "CA",
        customerName: "陆坤",
        declarationUnitPriceFen: 345,
        externalOrderNo: "PO-OTTAWA-001",
        logisticsProductCode: "",
        phone: "+1 613 555 0100",
        postalCode: "K1A 0B1",
        province: "ON",
        quantity: 2,
        recipientName: "Alice Chen",
        skuCode: "TZX-001",
        skuName: "纯棉收纳袋",
        storeName: "渥太华一店",
      },
      {
        addressLine1: "100 Main St",
        addressLine2: "Unit 8",
        city: "Ottawa",
        country: "CA",
        customerName: "陆坤",
        declarationUnitPriceFen: 500,
        externalOrderNo: "PO-OTTAWA-001",
        logisticsProductCode: "",
        phone: "+1 613 555 0100",
        postalCode: "K1A 0B1",
        province: "ON",
        quantity: 1,
        recipientName: "Alice Chen",
        skuCode: "TZX-002",
        skuName: "旅行收纳包",
        storeName: "渥太华一店",
      },
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const worksheet = workbook.getWorksheet("Sheet1");

    expect(worksheet).toBeDefined();
    expect(worksheet?.columnCount).toBe(16);
    expect(worksheet?.rowCount).toBe(3);
    expect(worksheet?.getRow(1).values).toEqual([, ...expectedHeaders]);
    expect(worksheet?.getRow(2).values).toEqual([
      ,
      "PO-OTTAWA-001",
      "陆坤",
      "渥太华一店",
      "纯棉收纳袋",
      "TZX-001",
      2,
      3.45,
      "Alice Chen",
      "+1 613 555 0100",
      "Ottawa",
      "ON",
      "K1A 0B1",
      "CA",
      "100 Main St",
      "Unit 8",
      "",
    ]);
    expect(worksheet?.getRow(3).getCell(1).value).toBe("PO-OTTAWA-001");
    expect(worksheet?.getRow(3).getCell(5).value).toBe("TZX-002");
    expect(String(worksheet?.getRow(2).getCell(5).value)).not.toContain("\n");

    expect(worksheet?.getRow(1).height).toBe(32);
    expect(worksheet?.getColumn(1).width).toBe(24.625);
    expect(worksheet?.getColumn(16).width).toBe(24);
    expect(worksheet?.getRow(1).getCell(1).font).toMatchObject({
      bold: true,
      name: "宋体",
      size: 14,
    });
    expect(worksheet?.getRow(1).getCell(2).font.color).toEqual({
      argb: "FFFF0000",
    });
    expect(worksheet?.getRow(1).getCell(1).alignment).toMatchObject({
      horizontal: "center",
      vertical: "middle",
    });
    expect(worksheet?.getRow(1).getCell(1).fill).toMatchObject({
      pattern: "solid",
      type: "pattern",
    });
  });
});
