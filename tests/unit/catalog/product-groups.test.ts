import { describe, expect, it, vi } from "vitest";

import {
  compareCatalogNaturally,
  filterCatalogGroups,
  filterCatalogGroupVariants,
  groupCatalogItems,
  sortCatalogGroups,
  type CatalogGroupableItem,
} from "@/modules/catalog/product-groups";

function item(
  overrides: Partial<CatalogGroupableItem> = {},
): CatalogGroupableItem {
  return {
    id: "sku-1",
    linkText: "View product",
    productId: "product-1",
    productName: "Product one",
    productUrl: "https://example.com/products/one",
    skuCode: "TZX-001-1",
    sourceSequence: "1",
    ...overrides,
  };
}

describe("groupCatalogItems", () => {
  it("groups three SKU variants under one product/source sequence", () => {
    const groups = groupCatalogItems([
      item({
        id: "sku-1",
        productId: "product-1",
        skuCode: "TZX-001-1",
        sourceSequence: "1",
      }),
      item({
        id: "sku-2",
        productId: "product-1",
        skuCode: "TZX-001-2",
        sourceSequence: "1",
      }),
      item({
        id: "sku-3",
        productId: "product-1",
        skuCode: "TZX-001-3",
        sourceSequence: "1",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].variants.map((variant) => variant.skuCode)).toEqual([
      "TZX-001-1",
      "TZX-001-2",
      "TZX-001-3",
    ]);
  });

  it("orders groups by numeric source sequence, product name, and product ID", () => {
    const groups = groupCatalogItems([
      item({ productId: "product-b", productName: "Same", sourceSequence: "10" }),
      item({ productId: "product-c", productName: "Same", sourceSequence: "2" }),
      item({ productId: "product-a", productName: "Same", sourceSequence: "2" }),
    ]);

    expect(groups.map((group) => group.productId)).toEqual([
      "product-a",
      "product-c",
      "product-b",
    ]);
  });

  it("uses deterministic natural ordering for Chinese names, numeric sequences, and SKU ties", () => {
    const groups = groupCatalogItems([
      item({
        id: "sku-b",
        productId: "product-report",
        productName: "报表商品 5C73AE3B",
        skuCode: "TZX-10",
        sourceSequence: "10",
      }),
      item({
        id: "sku-a-2",
        productId: "product-multi",
        productName: "多店铺商品 64D135AB",
        skuCode: "TZX-2",
        sourceSequence: "2",
      }),
      item({
        id: "sku-a-1",
        productId: "product-multi",
        productName: "多店铺商品 64D135AB",
        skuCode: "TZX-2",
        sourceSequence: "2",
      }),
    ]);

    expect(groups.map((group) => group.productName)).toEqual([
      "多店铺商品 64D135AB",
      "报表商品 5C73AE3B",
    ]);
    expect(groups[0]!.variants.map((variant) => variant.id)).toEqual([
      "sku-a-1",
      "sku-a-2",
    ]);
  });

  it("treats case and leading-zero-equivalent group keys as equal and falls back to product ID", () => {
    const groups = groupCatalogItems([
      item({
        productId: "product-b",
        productName: "ABC",
        sourceSequence: "01",
      }),
      item({
        productId: "product-a",
        productName: "abc",
        sourceSequence: "1",
      }),
    ]);

    expect(groups.map((group) => group.productId)).toEqual([
      "product-a",
      "product-b",
    ]);
  });

  it("treats case and leading-zero-equivalent SKU codes as equal and falls back to variant ID", () => {
    const groups = groupCatalogItems([
      item({
        id: "sku-b",
        productId: "product-a",
        productName: "Same",
        skuCode: "SKU-2",
      }),
      item({
        id: "sku-a",
        productId: "product-a",
        productName: "Same",
        skuCode: "sku-02",
      }),
    ]);

    expect(groups[0]!.variants.map((variant) => variant.id)).toEqual([
      "sku-a",
      "sku-b",
    ]);
  });

  it("preserves distinct sibling product links on variants", () => {
    const groups = groupCatalogItems([
      item({
        id: "sku-1",
        productUrl: "https://example.com/products/first-variant",
        skuCode: "TZX-001-1",
      }),
      item({
        id: "sku-2",
        productUrl: "https://example.com/products/second-variant",
        skuCode: "TZX-001-2",
      }),
    ]);

    expect(groups[0]).not.toHaveProperty("productUrl");
    expect(groups[0].variants.map((variant) => variant.productUrl)).toEqual([
      "https://example.com/products/first-variant",
      "https://example.com/products/second-variant",
    ]);
  });
});

describe("compareCatalogNaturally", () => {
  it("orders numeric tokens naturally without locale-specific collation", () => {
    expect(compareCatalogNaturally("2", "10")).toBeLessThan(0);
    expect(compareCatalogNaturally("TZX-2", "TZX-10")).toBeLessThan(0);
    expect(compareCatalogNaturally("多店铺商品 64D135AB", "报表商品 5C73AE3B")).toBeLessThan(0);
    expect(compareCatalogNaturally("same", "same")).toBe(0);
  });

  it("treats ASCII case and numerically equal digit runs as equal", () => {
    expect(compareCatalogNaturally("abc", "ABC")).toBe(0);
    expect(compareCatalogNaturally("sku-2", "SKU-2")).toBe(0);
    expect(compareCatalogNaturally("1", "01")).toBe(0);
    expect(compareCatalogNaturally("A2", "A02")).toBe(0);
  });

  it("does not depend on ambient Intl.Collator availability at module load", async () => {
    const originalCollator = Intl.Collator;
    vi.resetModules();

    Intl.Collator = class {
      constructor() {
        throw new Error("ambient collator should not be used");
      }
    } as unknown as typeof Intl.Collator;

    try {
      const freshProductGroups = await import("@/modules/catalog/product-groups");
      expect(freshProductGroups.compareCatalogNaturally("TZX-2", "TZX-10")).toBeLessThan(0);
      expect(
        freshProductGroups.groupCatalogItems([
          item({ productId: "product-report", productName: "报表商品 5C73AE3B", sourceSequence: "10" }),
          item({ productId: "product-multi", productName: "多店铺商品 64D135AB", sourceSequence: "2" }),
        ]).map((group) => group.productName),
      ).toEqual(["多店铺商品 64D135AB", "报表商品 5C73AE3B"]);
    } finally {
      Intl.Collator = originalCollator;
      vi.resetModules();
    }
  });
});

describe("filterCatalogGroups", () => {
  it("keeps the complete group when one SKU matches search", () => {
    const groups = groupCatalogItems([
      item({ id: "sku-1", skuCode: "TZX-001-1" }),
      item({ id: "sku-2", skuCode: "TZX-001-2" }),
      item({ id: "sku-3", skuCode: "TZX-001-3" }),
    ]);

    const filtered = filterCatalogGroups(
      groups,
      "001-2",
      (variant) => [variant.skuCode],
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].variants).toHaveLength(3);
  });

  it("matches group-level fields case-insensitively", () => {
    const groups = groupCatalogItems([
      item({ productName: "TZX Special Product", sourceSequence: "34" }),
    ]);

    expect(filterCatalogGroups(groups, "special", () => [])).toHaveLength(1);
    expect(filterCatalogGroups(groups, "34", () => [])).toHaveLength(1);
  });

  it("matches a non-first sibling link through variant search values", () => {
    const groups = groupCatalogItems([
      item({
        id: "sku-1",
        productUrl: "https://example.com/products/first-variant",
        skuCode: "TZX-001-1",
      }),
      item({
        id: "sku-2",
        productUrl: "https://example.com/products/second-variant",
        skuCode: "TZX-001-2",
      }),
    ]);

    const filtered = filterCatalogGroups(
      groups,
      "second-variant",
      (variant) => [variant.productUrl],
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].variants).toHaveLength(2);
  });
});

describe("filterCatalogGroupVariants", () => {
  it("filters variants by sale status and removes empty product groups", () => {
    const groups = groupCatalogItems([
      { ...item({ id: "sku-1", skuCode: "TZX-001-1" }), sellable: true },
      { ...item({ id: "sku-2", skuCode: "TZX-001-2" }), sellable: false },
      {
        ...item({
          id: "sku-3",
          productId: "product-2",
          productName: "Product two",
          skuCode: "TZX-002",
        }),
        sellable: false,
      },
    ]);

    const sellable = filterCatalogGroupVariants(groups, "SELLABLE", (item) => item.sellable);
    expect(sellable).toHaveLength(1);
    expect(sellable[0]!.variants.map((item) => item.skuCode)).toEqual(["TZX-001-1"]);

    const unavailable = filterCatalogGroupVariants(
      groups,
      "NOT_SELLABLE",
      (item) => item.sellable,
    );
    expect(unavailable.flatMap((group) => group.variants.map((item) => item.skuCode)))
      .toEqual(["TZX-001-2", "TZX-002"]);
  });
});

describe("sortCatalogGroups", () => {
  type PricedCatalogItem = CatalogGroupableItem & { price: number };

  function pricedItem(
    overrides: Partial<PricedCatalogItem> = {},
  ): PricedCatalogItem {
    return {
      ...item(),
      price: 1_000,
      ...overrides,
    };
  }

  it("defaults to natural SKU order when customer-safe groups have no source sequence", () => {
    const groups = groupCatalogItems([
      pricedItem({
        productId: "product-053",
        productName: "PP塑料吸管",
        skuCode: "TZX-053",
        sourceSequence: null,
      }),
      pricedItem({
        id: "sku-034-2",
        productId: "product-034",
        productName: "A4文件袋",
        skuCode: "TZX-034-2",
        sourceSequence: null,
      }),
      pricedItem({
        id: "sku-034-1",
        productId: "product-034",
        productName: "A4文件袋",
        skuCode: "TZX-034-1",
        sourceSequence: null,
      }),
      pricedItem({
        productId: "product-037",
        productName: "USB数据线",
        skuCode: "TZX-037-1",
        sourceSequence: null,
      }),
    ]);

    const sorted = sortCatalogGroups(groups, "SKU_ASC", (variant) => variant.price);

    expect(sorted.map((group) => group.productId)).toEqual([
      "product-034",
      "product-037",
      "product-053",
    ]);
    expect(sorted[0]!.variants.map((variant) => variant.skuCode)).toEqual([
      "TZX-034-1",
      "TZX-034-2",
    ]);
  });

  it("orders visible product groups and variants by price with SKU tie breakers", () => {
    const groups = groupCatalogItems([
      pricedItem({
        id: "sku-034-2",
        price: 1_500,
        productId: "product-034",
        skuCode: "TZX-034-2",
        sourceSequence: null,
      }),
      pricedItem({
        id: "sku-034-1",
        price: 1_350,
        productId: "product-034",
        skuCode: "TZX-034-1",
        sourceSequence: null,
      }),
      pricedItem({
        id: "sku-037-1",
        price: 3_100,
        productId: "product-037",
        skuCode: "TZX-037-1",
        sourceSequence: null,
      }),
      pricedItem({
        id: "sku-053",
        price: 2_000,
        productId: "product-053",
        skuCode: "TZX-053",
        sourceSequence: null,
      }),
    ]);

    const ascending = sortCatalogGroups(groups, "PRICE_ASC", (variant) => variant.price);
    expect(ascending.map((group) => group.productId)).toEqual([
      "product-034",
      "product-053",
      "product-037",
    ]);
    expect(ascending[0]!.variants.map((variant) => variant.skuCode)).toEqual([
      "TZX-034-1",
      "TZX-034-2",
    ]);

    const descending = sortCatalogGroups(groups, "PRICE_DESC", (variant) => variant.price);
    expect(descending.map((group) => group.productId)).toEqual([
      "product-037",
      "product-053",
      "product-034",
    ]);
    expect(descending[2]!.variants.map((variant) => variant.skuCode)).toEqual([
      "TZX-034-2",
      "TZX-034-1",
    ]);
  });
});
