import { describe, expect, it, vi } from "vitest";

import {
  compareCatalogNaturally,
  filterCatalogGroups,
  filterCatalogGroupVariants,
  groupCatalogItems,
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
