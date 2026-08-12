import { describe, expect, it } from "vitest";

import {
  findCrossStoreConflicts,
  findGroupsAffectedByShortage,
} from "@/modules/bulk-order/conflicts";

describe("findCrossStoreConflicts", () => {
  it("阻止共享文件摘要或子订单号的所有店铺分组", () => {
    const result = findCrossStoreConflicts([
      { fileHashes: ["h1"], groupId: "g1", subOrderNos: ["s1"] },
      { fileHashes: ["h1"], groupId: "g2", subOrderNos: ["s2"] },
      { fileHashes: ["h3"], groupId: "g3", subOrderNos: ["s1"] },
    ]);

    expect(result.blockedGroupIds).toEqual(new Set(["g1", "g2", "g3"]));
    expect(result.fileHashConflicts.get("h1")).toEqual(
      new Set(["g1", "g2"]),
    );
    expect(result.subOrderConflicts.get("s1")).toEqual(
      new Set(["g1", "g3"]),
    );
  });

  it("同一分组内部重复不构成跨店冲突", () => {
    const result = findCrossStoreConflicts([
      {
        fileHashes: ["h1", "h1"],
        groupId: "g1",
        subOrderNos: ["s1", "s1"],
      },
    ]);

    expect(result.blockedGroupIds).toEqual(new Set());
  });

  it("拒绝重复的店铺分组 ID", () => {
    expect(() =>
      findCrossStoreConflicts([
        { fileHashes: [], groupId: "g1", subOrderNos: [] },
        { fileHashes: [], groupId: "g1", subOrderNos: [] },
      ]),
    ).toThrow("店铺分组 ID 不能重复");
  });
});

describe("findGroupsAffectedByShortage", () => {
  it("合计短缺时阻止涉及该 SKU 的全部店铺，不影响其他店铺", () => {
    const result = findGroupsAffectedByShortage(
      [
        { groupId: "g1", quantityBySku: new Map([["sku-a", 4]]) },
        { groupId: "g2", quantityBySku: new Map([["sku-a", 3]]) },
        { groupId: "g3", quantityBySku: new Map([["sku-b", 2]]) },
      ],
      new Map([
        ["sku-a", 6],
        ["sku-b", 2],
      ]),
    );

    expect(result.blockedGroupIds).toEqual(new Set(["g1", "g2"]));
    expect(result.shortageBySku.get("sku-a")).toEqual({
      availableQuantity: 6,
      requiredQuantity: 7,
    });
  });

  it("拒绝重复分组 ID、负库存和非正需求", () => {
    expect(() =>
      findGroupsAffectedByShortage(
        [
          { groupId: "g1", quantityBySku: new Map([["sku-a", 1]]) },
          { groupId: "g1", quantityBySku: new Map([["sku-b", 1]]) },
        ],
        new Map(),
      ),
    ).toThrow("店铺分组 ID 不能重复");
    expect(() =>
      findGroupsAffectedByShortage(
        [{ groupId: "g1", quantityBySku: new Map([["sku-a", 0]]) }],
        new Map(),
      ),
    ).toThrow("SKU 需求数量必须为正数");
    expect(() =>
      findGroupsAffectedByShortage([], new Map([["sku-a", -1]])),
    ).toThrow("可售库存不能为负数");
  });
});
