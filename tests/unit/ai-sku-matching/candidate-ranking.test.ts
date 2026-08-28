import { describe, expect, it } from "vitest";

import {
  normalizeSkuMatchText,
  shortlistSkuCandidates,
} from "@/modules/ai-sku-matching/candidate-ranking";

const candidates = [
  {
    color: "红色",
    combination: null,
    id: "00000000-0000-4000-8000-000000000001",
    name: "红色牵引绳",
    productName: "反光宠物牵引绳",
    skuCode: "TZX-001-RED",
    specification: "150×80",
  },
  {
    color: "黑色",
    combination: null,
    id: "00000000-0000-4000-8000-000000000002",
    name: "黑色牵引绳",
    productName: "反光宠物牵引绳",
    skuCode: "TZX-001-BLACK",
    specification: "150×80",
  },
  {
    color: "蓝色",
    combination: "两件套",
    id: "00000000-0000-4000-8000-000000000003",
    name: "蓝色项圈",
    productName: "宠物项圈",
    skuCode: "TZX-088-BLUE",
    specification: "M",
  },
];

describe("normalizeSkuMatchText", () => {
  it("normalizes full-width text, case and punctuation without inventing content", () => {
    expect(normalizeSkuMatchText(" ＴＺＸ－001－ＲＥＤ / 红 色 ")).toBe(
      "tzx001red红色",
    );
  });
});

describe("shortlistSkuCandidates", () => {
  it("ranks matching SKU, product and color signals ahead of unrelated goods", () => {
    const ranked = shortlistSkuCandidates(
      {
        externalSku: "tzx-001-red-lk",
        productAttributes: "颜色：红色；尺寸：150*80",
        productName: "反光宠物牵引绳",
      },
      candidates,
      2,
    );

    expect(ranked.map((candidate) => candidate.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("is deterministic and respects the requested upper bound", () => {
    const source = {
      externalSku: "unknown",
      productAttributes: null,
      productName: "宠物用品",
    };

    expect(shortlistSkuCandidates(source, candidates, 1)).toEqual(
      shortlistSkuCandidates(source, candidates, 1),
    );
    expect(shortlistSkuCandidates(source, candidates, 1)).toHaveLength(1);
  });
});
