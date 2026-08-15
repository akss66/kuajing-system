import cargoSourceValues from "@/../tests/fixtures/feishu/cargo-source-values.json";
import { buildFieldAlignedCargoSourceFixture } from "@/../tests/fixtures/feishu/field-aligned-cargo-source";
import { parseLegacyCargoSheet } from "@/modules/feishu/cargo-parser";

import { describe, expect, test } from "vitest";

function sampleRows() {
  return withCargoPriceColumn(
    structuredClone((cargoSourceValues as unknown[][]).slice(0, 5)),
  );
}

function fullFixture() {
  return withCargoPriceColumn(structuredClone(cargoSourceValues as unknown[][]));
}

function withCargoPriceColumn(values: unknown[][]) {
  return values.map((row, index) => [
    ...row,
    index === 0 ? "货品价格" : row[4],
  ]);
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
    expect(result.rows[3].saleStatus).toBe("SELLABLE");
    expect(result.rows[0].defaultUnitPriceFen).toBe(293);
    expect(result.rows[0].defaultUnitPriceMilliYuan).toBe(2_930);
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
      sourceSequenceCount: 72,
      skuCount: 74,
      totalQuantity: 377,
    });
    expect(result.issues).toEqual([]);
  });

  test("counts source sequences independently from SKU rows", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(parsed.summary).toMatchObject({
      productCount: 74,
      skuCount: 140,
      sourceSequenceCount: 74,
    });
  });

  test("keeps every field-aligned SKU code unique", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(new Set(parsed.rows.map((row) => row.skuCode)).size).toBe(140);
  });

  test("keeps every field-aligned image token unique", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(new Set(parsed.rows.map((row) => row.imageFileToken)).size).toBe(140);
  });

  test("inherits source sequence 34 across all of its SKUs", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(
      parsed.rows
        .filter((row) => row.sourceSequence === "34")
        .map((row) => row.skuCode),
    ).toEqual(["TZX-034-1", "TZX-034-2", "TZX-034-3"]);
  });

  test("keeps cargo price independent from the SKU default price", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(
      parsed.rows.find((row) => row.skuCode === "TZX-034-1"),
    ).toMatchObject({
      cargoUnitPriceMilliYuan: 1366,
      defaultUnitPriceMilliYuan: 325,
    });
  });

  test("recognizes the production long-form cargo price header without confusing it with purchase price", () => {
    const values = buildFieldAlignedCargoSourceFixture().value;
    const cargoPriceIndex = values[0].indexOf("货品价格");
    values[0][cargoPriceIndex] = "货品价格\n（采购价+头程+打包材料+人工费）";

    const parsed = parseLegacyCargoSheet(values);

    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.find((row) => row.skuCode === "TZX-034-1")).toMatchObject({
      cargoUnitPriceMilliYuan: 1366,
      defaultUnitPriceMilliYuan: 325,
    });
  });

  test("keeps a manually sellable zero-stock SKU sellable", () => {
    const parsed = parseLegacyCargoSheet(
      buildFieldAlignedCargoSourceFixture().value,
    );

    expect(parsed.rows.find((row) => row.skuCode === "TZX-034-1")).toMatchObject({
      saleStatus: "SELLABLE",
      totalQuantity: 0,
    });
  });

  test("blocks a field-aligned source without the exact cargo price header", () => {
    const values = buildFieldAlignedCargoSourceFixture().value;
    values[0] = values[0].filter((header) => header !== "货品价格");

    const parsed = parseLegacyCargoSheet(values);

    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toContainEqual({
      code: "CARGO_HEADER_NOT_FOUND",
      message: "未找到旧飞书货盘表头",
      severity: "BLOCKING",
    });
  });

  test("blocks a malformed field-aligned cargo price", () => {
    const values = buildFieldAlignedCargoSourceFixture().value;
    const cargoPriceIndex = values[0].indexOf("货品价格");
    values[1][cargoPriceIndex] = "not-a-price";

    const parsed = parseLegacyCargoSheet(values);

    expect(parsed.rows.map((row) => row.skuCode)).not.toContain("TZX-001-1");
    expect(parsed.issues).toContainEqual({
      code: "CARGO_INVALID_CARGO_PRICE",
      message: "货品价格必须是合法人民币金额",
      severity: "BLOCKING",
      sourceRowNumber: 2,
    });
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

  test("keeps explicit source sequence grouping when TZX product numbers differ", () => {
    const values = sampleRows();
    values.push([
      "1",
      "TZX-003",
      { fileToken: "file-token-tzx-003" },
      "Third product",
      "4.50",
      "8",
      "8",
      { text: "Third product", link: "https://example.test/products/tzx-003" },
      "Standard",
      "Gray",
      "1pc",
      "140g",
      "可售",
      "4.50",
    ]);
    values.push([
      "1",
      "TZX-004",
      { fileToken: "file-token-tzx-004" },
      "Fourth product",
      "5.00",
      "3",
      "3",
      { text: "Fourth product", link: "https://example.test/products/tzx-004" },
      "Standard",
      "Blue",
      "1pc",
      "150g",
      "可售",
      "",
    ]);

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "CARGO_SEQUENCE_SKU_MISMATCH" }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        code: "CARGO_SOURCE_SEQUENCE_MULTIPLE_PRODUCT_GROUPS",
      }),
    );
    expect(result.rows.slice(-2)).toMatchObject([
      {
        cargoUnitPriceMilliYuan: 4_500,
        productGroupKey: "1",
        skuCode: "TZX-003",
        sourceSequence: "1",
      },
      {
        cargoUnitPriceMilliYuan: 4_500,
        inheritedFrom: { cargoPrice: 6 },
        productGroupKey: "1",
        skuCode: "TZX-004",
        sourceSequence: "1",
      },
    ]);
  });

  test("skips a trailing SKU-only draft without inheriting the previous product", () => {
    const values = sampleRows();
    values.push(["", "TZX-077", "", "", "", "", "", "", "", "", "", "", ""]);

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.map((row) => row.skuCode)).not.toContain("TZX-077");
    expect(result.issues).toContainEqual({
      code: "CARGO_TRAILING_SKU_DRAFT_SKIPPED",
      message: "末尾 SKU TZX-077 仅有编号且资料未完成，本次迁移已跳过",
      severity: "WARNING",
      sourceRowNumber: 6,
    });
  });

  test("does not skip an incomplete SKU-only row in the middle of the sheet", () => {
    const values = sampleRows();
    values.push(["", "TZX-077", "", "", "", "", "", "", "", "", "", "", ""]);
    values.push([
      "78",
      "TZX-078",
      { fileToken: "file-token-tzx-078" },
      "Complete product",
      "1.00",
      "1",
      "1",
      { text: "Complete product", link: "https://example.test/products/tzx-078" },
      "Standard",
      "Gray",
      "1pc",
      "10g",
      "可售",
      "1.00",
    ]);

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.map((row) => row.skuCode)).not.toContain("TZX-077");
    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_TOTAL_QUANTITY",
      message: "总库存必须是非负安全整数",
      severity: "BLOCKING",
      sourceRowNumber: 6,
    });
  });

  test("accepts the production inventory header with the unit in parentheses", () => {
    const values = sampleRows();
    values[0][5] = "总库存(份)";

    const result = parseLegacyCargoSheet(values);

    expect(result.headerRowNumber).toBe(1);
    expect(result.rows).toHaveLength(4);
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "CARGO_HEADER_NOT_FOUND" }),
    );
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
    { expectedFen: 33, expectedMilliYuan: 325, raw: "0.325" },
    { expectedFen: 137, expectedMilliYuan: 1_366, raw: "1.366" },
  ])("preserves exact milli-yuan price $raw", ({ expectedFen, expectedMilliYuan, raw }) => {
    const values = sampleRows();
    values[1][4] = raw;

    const result = parseLegacyCargoSheet(values);

    expect(result.rows[0]).toMatchObject({
      defaultUnitPriceFen: expectedFen,
      defaultUnitPriceMilliYuan: expectedMilliYuan,
    });
    expect(result.issues).toEqual([]);
  });

  test.each([
    { raw: "0.58/6PCS", expectedFen: 58, expectedMilliYuan: 580 },
    { raw: "0.35/5PCS", expectedFen: 35, expectedMilliYuan: 350 },
  ])("treats $raw as the price of one packaged SKU", ({ expectedFen, expectedMilliYuan, raw }) => {
    const values = sampleRows();
    values[1][4] = raw;

    const result = parseLegacyCargoSheet(values);

    expect(result.rows[0]).toMatchObject({
      defaultUnitPriceFen: expectedFen,
      defaultUnitPriceMilliYuan: expectedMilliYuan,
    });
    expect(result.issues).toContainEqual({
      code: "CARGO_PACK_PRICE_NORMALIZED",
      message: `${raw} 按一个整包 SKU 的采购价导入，不按 PCS 拆分单价`,
      severity: "WARNING",
      sourceRowNumber: 2,
    });
  });

  test.each([
    { expected: 50, raw: "50g/包" },
    { expected: 36, raw: "9g*4" },
    { expected: 18, raw: "6g*3" },
    { expected: 13, raw: "12.5g" },
  ])("normalizes legacy weight $raw to $expected grams", ({ expected, raw }) => {
    const values = sampleRows();
    values[3][11] = raw;

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.find((row) => row.sourceRowNumber === 4)?.weightGrams).toBe(expected);
    expect(result.issues).toContainEqual({
      code: "CARGO_WEIGHT_NOTATION_NORMALIZED",
      message: `${raw} 已按确认规则转换为 ${expected}g`,
      severity: "WARNING",
      sourceRowNumber: 4,
    });
  });

  test.each([
    { combination: "6PCS", expected: 90, raw: "15g/PCS" },
    { combination: "5PCS", expected: 25, raw: "5g/PCS" },
  ])(
    "normalizes per-piece weight $raw using packaged combination $combination",
    ({ combination, expected, raw }) => {
      const values = sampleRows();
      values[3][10] = combination;
      values[3][11] = raw;

      const result = parseLegacyCargoSheet(values);

      expect(
        result.rows.find((row) => row.sourceRowNumber === 4)?.weightGrams,
      ).toBe(expected);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "CARGO_WEIGHT_NOTATION_NORMALIZED",
          severity: "WARNING",
          sourceRowNumber: 4,
        }),
      );
      expect(result.issues).not.toContainEqual(
        expect.objectContaining({
          code: "CARGO_INVALID_WEIGHT",
          sourceRowNumber: 4,
        }),
      );
    },
  );

  test("normalizes product link sentinel 0 to an inherited null link", () => {
    const values = sampleRows();
    values[1][7] = "0";
    values[2][7] = "";

    const result = parseLegacyCargoSheet(values);

    expect(result.rows[0].productUrl).toBeNull();
    expect(result.rows[1].productUrl).toBeNull();
    expect(result.rows[1].inheritedFrom.productUrl).toBe(2);
    expect(result.issues).toContainEqual({
      code: "CARGO_PRODUCT_URL_SENTINEL_NORMALIZED",
      message: "链接文字 0 按无商品链接导入",
      severity: "WARNING",
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

  test.each([
    {
      cell: [{ text: "坏链接", link: "/relative/path", type: "url" }],
      label: "/relative/path",
    },
    {
      cell: [{ text: "坏链接", link: "javascript:alert(1)", type: "url" }],
      label: "javascript:alert(1)",
    },
    {
      cell: [{ text: "坏链接", link: "ftp://example.test/file", type: "url" }],
      label: "ftp://example.test/file",
    },
    {
      cell: [
        { text: "一", link: "https://example.test/a", type: "url" },
        { text: "二", link: "https://example.test/b", type: "url" },
      ],
      label: "ambiguous rich link",
    },
  ])("does not inherit a previous valid product url when the current cell is explicitly invalid: $label", ({ cell }) => {
    const values = sampleRows();
    values[2][7] = cell as unknown;

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.map((row) => row.skuCode)).not.toContain("TZX-001-2");
    expect(result.issues).toContainEqual({
      code: "CARGO_INVALID_PRODUCT_URL",
      message: "链接文字必须包含合法的绝对 http/https URL",
      severity: "BLOCKING",
      sourceRowNumber: 3,
    });
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

  test("inherits a merged sale status within the same product group", () => {
    const values = sampleRows();
    values[2][12] = "";

    const result = parseLegacyCargoSheet(values);

    const inherited = result.rows.find((row) => row.sourceRowNumber === 3);
    expect(inherited?.saleStatus).toBe("SELLABLE");
    expect(inherited?.inheritedFrom.saleStatus).toBe(2);
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        code: "CARGO_MISSING_SALE_STATUS",
        sourceRowNumber: 3,
      }),
    );
  });

  test("rejects a missing sale status when no product-group value exists", () => {
    const values = sampleRows();
    values[1][12] = "";

    const result = parseLegacyCargoSheet(values);

    expect(result.issues).toContainEqual({
      code: "CARGO_MISSING_SALE_STATUS",
      message: "状态不能为空",
      severity: "BLOCKING",
      sourceRowNumber: 2,
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

  test("treats a numeric Feishu weight cell as grams", () => {
    const values = sampleRows();
    values[3][11] = 57;

    const result = parseLegacyCargoSheet(values);

    expect(result.rows.find((row) => row.sourceRowNumber === 4)?.weightGrams).toBe(57);
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        code: "CARGO_INVALID_WEIGHT",
        sourceRowNumber: 4,
      }),
    );
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
        "货品价格",
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
        "1.00",
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
        "1.00",
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
      sourceSequenceCount: 2,
      skuCount: 2,
      totalQuantity: 0,
    });
    expect(Number.isSafeInteger(result.summary.totalQuantity)).toBe(true);
  });
});
