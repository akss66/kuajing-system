import { describe, expect, test } from "vitest";

import {
  deriveImportSkuResolution,
  multiplyImportQuantity,
} from "@/modules/order-import/sku-resolution";

describe("deriveImportSkuResolution", () => {
  test("keeps exact SYSTEM_SKU before suffix normalization", () => {
    expect(deriveImportSkuResolution("TZX-014-3")).toEqual({
      fulfillmentMode: "SYSTEM_SKU",
      lookupCandidates: ["TZX-014-3"],
      quantityMultiplier: 1,
    });
  });

  test("removes only a terminal LK suffix case-insensitively", () => {
    expect(deriveImportSkuResolution("TZX-014-3-lk")).toEqual({
      fulfillmentMode: "SYSTEM_SKU",
      lookupCandidates: ["TZX-014-3-lk", "TZX-014-3"],
      quantityMultiplier: 1,
    });
  });

  test("converts terminal PCS and combined PCS-LK to an effective multiplier", () => {
    expect(deriveImportSkuResolution("TZX-024-2PCS")).toEqual({
      fulfillmentMode: "SYSTEM_SKU",
      lookupCandidates: ["TZX-024-2PCS", "TZX-024"],
      quantityMultiplier: 2,
    });
    expect(deriveImportSkuResolution("TZX-024-2pcs-LK")).toEqual({
      fulfillmentMode: "SYSTEM_SKU",
      lookupCandidates: ["TZX-024-2pcs-LK", "TZX-024-2pcs", "TZX-024"],
      quantityMultiplier: 2,
    });
  });

  test("classifies non-TZX rows as customer supplied without normalization", () => {
    expect(deriveImportSkuResolution("QS-014-1-LK")).toEqual({
      fulfillmentMode: "CUSTOMER_SUPPLIED",
      lookupCandidates: [],
      quantityMultiplier: 1,
    });
  });

  test("rejects unsafe multipliers and protects quantity multiplication", () => {
    expect(() => deriveImportSkuResolution("TZX-024-0PCS")).toThrow(
      "PCS 件数必须是安全正整数",
    );
    expect(() =>
      deriveImportSkuResolution("TZX-024-999999999999999999PCS"),
    ).toThrow("PCS 件数必须是安全正整数");
    expect(() => multiplyImportQuantity(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      "导入数量超出系统范围",
    );
  });
});
