import cargoSourceValues from "@/../tests/fixtures/feishu/cargo-source-values.json";
import { parseLegacyCargoSheet } from "@/modules/feishu/cargo-parser";

import { describe, expect, test } from "vitest";

function sampleRows() {
  return structuredClone((cargoSourceValues as unknown[][]).slice(0, 5));
}

function fullFixture() {
  return structuredClone(cargoSourceValues as unknown[][]);
}

describe("parseLegacyCargoSheet", () => {
  test("parses merged rows into strict parsed cargo rows", () => {
    const result = parseLegacyCargoSheet(sampleRows());

    expect(result.headerRowNumber).toBe(1);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.slice(0, 3).map((row) => row.productGroupKey)).toEqual([
      "1",
      "1",
      "1",
    ]);
    expect(result.rows[1].inheritedFrom.productName).toBe(2);
    expect(result.rows[1].skuCode).toBe("TZX-001-2");
    expect(result.rows[2].weightGrams).toBe(218);
    expect(result.rows[3].saleStatus).toBe("NOT_SELLABLE");
    expect(result.rows[0].defaultUnitPriceFen).toBe(293);
    expect(result.rows[0].productUrl).toBe("https://example.test/products/tzx-001");
    expect(result.rows[0].imageFileToken).toBe("file-token-tzx-001-1");
    expect(result.issues).toEqual([]);
  });

  test("parses the synthetic 74 sku fixture with summary totals", () => {
    const result = parseLegacyCargoSheet(fullFixture());

    expect(result.rows).toHaveLength(74);
    expect(result.summary).toEqual({
      imageCount: 74,
      productCount: 72,
      skuCount: 74,
      totalQuantity: 377,
    });
    expect(result.issues).toEqual([]);
  });

  test("finds the header row within the first twenty rows", () => {
    const result = parseLegacyCargoSheet([
      ["legacy cargo export"],
      [null, "generated at 2026-08-13"],
      ...sampleRows(),
    ]);

    expect(result.headerRowNumber).toBe(3);
    expect(result.rows).toHaveLength(4);
  });

  test("resets merged-field inheritance after a blank separator row", () => {
    const values = sampleRows();
    const blankRow = Array.from({ length: 13 }, () => "");
    values.splice(3, 0, blankRow);
    values[4] = ["2", "TZX-900-1", "", "", "", "5", "5", "", "", "", "", "", "可售"];

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.map((row) => row.skuCode)).not.toContain("TZX-900-1");
    expect(result.issues).toContainEqual({
      code: "CARGO_MISSING_PRODUCT_NAME",
      message: "名称不能为空",
      severity: "BLOCKING",
      sourceRowNumber: 5,
    });
  });

  test("reports duplicate sku rows as blocking", () => {
    const values = sampleRows();
    values[2][1] = "TZX-001-1";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_DUPLICATE_SKU",
      message: "SKU 重复：TZX-001-1",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("reports duplicate sku rows even when the repeated row has other blocking issues", () => {
    const values = sampleRows();
    values[2][1] = "TZX-001-1";
    values[2][5] = "7.5";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_DUPLICATE_SKU",
      message: "SKU 重复：TZX-001-1",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_TOTAL_QUANTITY",
      message: "总库存必须是非负安全整数",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("reports every repeated sku occurrence after the first one", () => {
    const values = sampleRows();
    values[2][1] = "TZX-001-1";
    values[3][1] = "TZX-001-1";

    const result = parseLegacyCargoSheet(values);

    expect(
      result.issues.filter((issue) => issue.code === "CARGO_DUPLICATE_SKU"),
    ).toEqual([
      {
        code: "CARGO_DUPLICATE_SKU",
        message: "SKU 重复：TZX-001-1",
        severity: "BLOCKING",
        sourceRowNumber: 3,
      },
      {
        code: "CARGO_DUPLICATE_SKU",
        message: "SKU 重复：TZX-001-1",
        severity: "BLOCKING",
        sourceRowNumber: 4,
      },
    ]);
  });

  test("reports a missing sku instead of inheriting it from the merged row above", () => {
    const values = sampleRows();
    values[2][1] = "";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_MISSING_SKU",
      message: "SKU 不能为空",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("does not inherit color from the previous row", () => {
    const values = sampleRows();
    values[2][9] = "";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toEqual([]);
    expect(result.rows[1].color).toBeNull();
    expect(result.rows[1].inheritedFrom).not.toHaveProperty("color");
  });

  test("reports invalid inventory instead of inheriting it from the previous row", () => {
    const values = sampleRows();
    values[2][5] = "7.5";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_TOTAL_QUANTITY",
      message: "总库存必须是非负安全整数",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("reports an invalid price cell as blocking", () => {
    const values = sampleRows();
    values[1][4] = "2.9.3";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_PRICE",
      message: "采购价必须是合法人民币金额",
      severity: "BLOCKING",
      sourceRowNumber: 2,
    });
  });

  test.each([
    "/relative/path",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "ftp://example.test/file",
    "https://",
  ])("rejects invalid rich link url %s", (invalidUrl) => {
    const values = sampleRows();
    values[1][7] = [{ text: "探险杯套装", link: invalidUrl, type: "url" }];

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_PRODUCT_URL",
      message: "链接文字必须包含合法的绝对 http/https URL",
      severity: "BLOCKING",
      sourceRowNumber: 2,
    });
  });

  test("rejects display text without the true product url", () => {
    const values = sampleRows();
    values[1][7] = "点我查看";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_MISSING_PRODUCT_URL",
      message: "链接文字必须包含真实 URL",
      severity: "BLOCKING",
      sourceRowNumber: 2,
    });
  });

  test("keeps the source href instead of the display text for rich links", () => {
    const values = sampleRows();
    values[1][7] = [{ text: "点击查看", link: "https://example.test/products/tzx-001?ref=sheet", type: "url" }];

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toEqual([]);
    expect(result.rows[0].linkText).toBe("点击查看");
    expect(result.rows[0].productUrl).toBe("https://example.test/products/tzx-001?ref=sheet");
  });

  test("rejects explicit sale status values it does not recognize", () => {
    const values = sampleRows();
    values[2][12] = "停售中";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_SALE_STATUS",
      message: "状态必须是可售或不可售",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("rejects missing explicit sale status instead of inheriting it", () => {
    const values = sampleRows();
    values[2][12] = "";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_MISSING_SALE_STATUS",
      message: "状态不能为空",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
  });

  test("rejects unsafe weight forms", () => {
    const values = sampleRows();
    values[3][11] = "-0.5kg";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_WEIGHT",
      message: "重量必须转换为非负安全整数克",
      severity: "BLOCKING",
      sourceRowNumber: 4,
    });
  });

  test("rejects image cells that contain multiple file tokens", () => {
    const values = sampleRows();
    values[1][2] = [
      {
        fileToken: "file-token-a",
        link: "https://example.test/assets/a.png",
        text: "Image A",
      },
      {
        fileToken: "file-token-b",
        link: "https://example.test/assets/b.png",
        text: "Image B",
      },
    ];

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_AMBIGUOUS_IMAGE",
      message: "图片单元格必须且只能包含一个 fileToken",
      severity: "BLOCKING",
      sourceRowNumber: 2,
    });
  });

  test("reports summary overflow as blocking and keeps summary totals safe", () => {
    const result = parseLegacyCargoSheet([
      [
        "序号",
        "SKU",
        "图片",
        "名称",
        "采购价",
        "总库存",
        "可售库存",
        "链接文字",
        "规格",
        "颜色",
        "组合销售",
        "重量",
        "状态",
      ],
      [
        "1",
        "MAX-001",
        { fileToken: "file-token-max-001", link: "https://example.test/assets/max-001.png", text: "Image MAX-001" },
        "大库存商品",
        "1.00",
        String(Number.MAX_SAFE_INTEGER),
        String(Number.MAX_SAFE_INTEGER),
        [{ text: "大库存商品", link: "https://example.test/products/max-001", type: "url" }],
        "标准款",
        "黑色",
        "单个",
        "1g",
        "可售",
      ],
      [
        "2",
        "MAX-002",
        { fileToken: "file-token-max-002", link: "https://example.test/assets/max-002.png", text: "Image MAX-002" },
        "溢出商品",
        "1.00",
        "1",
        "1",
        [{ text: "溢出商品", link: "https://example.test/products/max-002", type: "url" }],
        "标准款",
        "白色",
        "单个",
        "1g",
        "可售",
      ],
    ]);

    expect(result.issues).toContainEqual({
      code: "CARGO_SUMMARY_TOTAL_QUANTITY_OVERFLOW",
      message: "汇总总库存超过安全整数上限",
      severity: "BLOCKING",
    });
    expect(result.summary).toEqual({
      imageCount: 2,
      productCount: 2,
      skuCount: 2,
      totalQuantity: 0,
    });
    expect(Number.isSafeInteger(result.summary.totalQuantity)).toBe(true);
  });
});
