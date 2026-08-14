import { describe, expect, it } from "vitest";

import {
  filterCatalogGroups,
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
