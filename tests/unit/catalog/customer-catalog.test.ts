import { vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));

import { describe, expect, it } from "vitest";

import {
  toCustomerCatalogItems,
  type CustomerCatalogRecord,
} from "@/modules/catalog/customer-catalog";

describe("toCustomerCatalogItems", () => {
  it("drops source sequence before customer catalog rows cross the server boundary", () => {
    const rows: CustomerCatalogRecord[] = [
      {
        actualUnitPriceFen: 760,
        actualUnitPriceMilliYuan: 7_600,
        availabilityReason: "AVAILABLE",
        availableQuantity: 6,
        color: "炭黑",
        combination: "10 件组合装",
        id: "customer-sku-available",
        imageUrl: "/api/catalog-assets/asset-available",
        linkText: "查看商品详情",
        orderable: true,
        productId: "customer-product-available",
        productName: "冬季运输防护袋",
        productUrl: "https://example.test/products/available",
        saleStatus: "SELLABLE",
        sellable: true,
        skuCode: "TZX-CUSTOMER-001",
        skuName: "SKU 名称不能冒充规格",
        sourceSequence: "34",
        specification: "黑色 10 件装",
        weightGrams: 480,
      },
    ];

    expect(toCustomerCatalogItems(rows)).toEqual([
      {
        actualUnitPriceFen: 760,
        actualUnitPriceMilliYuan: 7_600,
        availabilityReason: "AVAILABLE",
        availableQuantity: 6,
        color: "炭黑",
        combination: "10 件组合装",
        id: "customer-sku-available",
        imageUrl: "/api/catalog-assets/asset-available",
        linkText: "查看商品详情",
        orderable: true,
        productId: "customer-product-available",
        productName: "冬季运输防护袋",
        productUrl: "https://example.test/products/available",
        saleStatus: "SELLABLE",
        sellable: true,
        skuCode: "TZX-CUSTOMER-001",
        skuName: "SKU 名称不能冒充规格",
        specification: "黑色 10 件装",
        weightGrams: 480,
      },
    ]);
    expect(toCustomerCatalogItems(rows)[0]).not.toHaveProperty("sourceSequence");
  });
});
