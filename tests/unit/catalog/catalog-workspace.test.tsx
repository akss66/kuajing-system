// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { matchesCustomerCatalogQuery } from "@/app/(customer)/portal/catalog/page";
import {
  CatalogWorkspace,
  CustomerCatalogWorkspace,
} from "@/components/catalog/catalog-workspace";
import type { AdminCatalogItem } from "@/modules/catalog/admin-catalog";
import type { CustomerCatalogItem } from "@/modules/catalog/customer-catalog";
import type { ManagedAction } from "@/shared/action-state";

vi.mock("next/image", () => ({
  default: ({
    alt,
    src,
    unoptimized,
    ...props
  }: ImgHTMLAttributes<HTMLImageElement> & {
    priority?: boolean;
    unoptimized?: boolean;
  }) => {
    void unoptimized;
    return createElement("img", { alt, src, ...props });
  },
}));

vi.mock("@/modules/catalog/customer-catalog", () => ({
  listCustomerCatalog: vi.fn(),
}));

vi.mock("@/modules/identity/principal", () => ({
  getCurrentPrincipal: vi.fn(),
}));

const successfulAction: ManagedAction = async () => ({ status: "success" });

const longSpecification =
  "适用于加拿大冬季运输场景的超长规格说明，包含加厚防护层、可重复封装结构与批次追踪标识，内容必须稳定换行且不能侵入相邻价格或库存列；同时包含耐低温材料、双重封口、清晰批次标签与长途运输缓冲说明，确保超过一百个字符时仍然保持完整可读。";

const adminRows: AdminCatalogItem[] = [
  {
    availableQuantity: 7,
    cargoUnitPriceMilliYuan: 1_366,
    color: "炭黑",
    combination: "10 件组合装",
    defaultUnitPriceMilliYuan: 325,
    id: "sku-34-2",
    imageUrl: "/api/catalog-assets/asset-34-2",
    linkText: "查看飞书商品",
    productName: "冬季运输防护袋",
    productUrl: "https://example.test/products/34",
    saleStatus: "SELLABLE",
    skuCode: "TZX-034-2",
    sourceSequence: "34",
    specification: longSpecification,
    totalQuantity: 10,
    weightGrams: 480,
  },
  {
    availableQuantity: 5,
    cargoUnitPriceMilliYuan: null,
    color: null,
    combination: null,
    defaultUnitPriceMilliYuan: 9_900,
    id: "sku-77-1",
    imageUrl: null,
    linkText: null,
    productName: "日常发圈",
    productUrl: null,
    saleStatus: "NOT_SELLABLE",
    skuCode: "TZX-WHITE-002",
    sourceSequence: "77",
    specification: "白色 20 件装",
    totalQuantity: 5,
    weightGrams: null,
  },
];

const customerRows: CustomerCatalogItem[] = [
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
    productName: "冬季运输防护袋",
    productUrl: "https://example.test/products/available",
    saleStatus: "SELLABLE",
    sellable: true,
    skuCode: "TZX-CUSTOMER-001",
    skuName: "SKU 名称不能冒充规格",
    specification: longSpecification,
    weightGrams: 480,
  },
  {
    actualUnitPriceFen: 880,
    actualUnitPriceMilliYuan: 8_800,
    availabilityReason: "MANUALLY_UNAVAILABLE",
    availableQuantity: 5,
    color: "海盐白",
    combination: null,
    id: "customer-sku-manual",
    imageUrl: null,
    linkText: "人工不可售商品",
    orderable: false,
    productName: "人工暂停销售商品",
    productUrl: "https://example.test/products/manual",
    saleStatus: "NOT_SELLABLE",
    sellable: false,
    skuCode: "TZX-CUSTOMER-002",
    skuName: "错误的人工不可售规格",
    specification: "白色 20 件装",
    weightGrams: null,
  },
  {
    actualUnitPriceFen: 990,
    actualUnitPriceMilliYuan: 9_900,
    availabilityReason: "SOLD_OUT",
    availableQuantity: 0,
    color: null,
    combination: "单件装",
    id: "customer-sku-sold-out",
    imageUrl: null,
    linkText: null,
    orderable: false,
    productName: "暂时售罄商品",
    productUrl: null,
    saleStatus: "SELLABLE",
    sellable: false,
    skuCode: "TZX-CUSTOMER-003",
    skuName: "错误的售罄规格",
    specification: "轻量单件装",
    weightGrams: 120,
  },
];

afterEach(() => {
  cleanup();
});

describe("catalog workspaces", () => {
  it("keeps catalog mutations out of the resource list until their drawers open", async () => {
    render(
      <CatalogWorkspace
        actions={{
          createAlias: successfulAction,
          createSku: successfulAction,
          setCustomerPrice: successfulAction,
        }}
        customers={[{ code: "NORTH-01", id: "customer-1" }]}
        rows={[adminRows[0]!]}
        stores={[{ id: "store-1", name: "Temu North" }]}
      />,
    );

    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button")[0]!);

    const createDrawer = await screen.findByRole("dialog");
    expect(within(createDrawer).getAllByRole("textbox").length).toBeGreaterThanOrEqual(4);
    const submitButton = within(createDrawer)
      .getAllByRole("button")
      .find((button) => button.getAttribute("type") === "submit");
    expect(submitButton).toBeEnabled();
  });

  it("renders the complete admin field mapping in a semantic table and ordered cards", () => {
    render(
      <CatalogWorkspace
        actions={{
          createAlias: successfulAction,
          createSku: successfulAction,
          setCustomerPrice: successfulAction,
        }}
        customers={[]}
        rows={adminRows}
        stores={[]}
      />,
    );

    const desktopTable = screen.getByRole("table", {
      name: "商品与 SKU 列表",
    });
    expect(
      within(desktopTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "序号",
      "商品",
      "规格/属性",
      "采购价",
      "总库存",
      "可售库存",
      "货品价格",
      "状态",
      "链接",
    ]);
    expect(within(desktopTable).getByText("¥0.325")).toBeVisible();
    expect(within(desktopTable).getByText("¥1.366")).toBeVisible();
    expect(within(desktopTable).getByText("10")).toBeVisible();
    expect(within(desktopTable).getByText("7")).toBeVisible();

    const links = screen.getAllByRole("link", { name: "查看飞书商品" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "https://example.test/products/34");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }

    const productImages = screen.getAllByRole("img", {
      name: "冬季运输防护袋 商品图片",
    });
    expect(productImages).toHaveLength(2);
    for (const image of productImages) {
      expect(image).toHaveAttribute("width", "48");
      expect(image).toHaveAttribute("height", "48");
    }
    expect(
      screen.getAllByRole("img", { name: "日常发圈 图片缺失" }),
    ).toHaveLength(2);

    const specifications = screen.getAllByText(longSpecification);
    expect(specifications).toHaveLength(2);
    for (const specification of specifications) {
      expect(specification).toHaveClass(
        "line-clamp-2",
        "whitespace-normal",
        "break-words",
      );
    }

    const cards = screen.getByRole("list", { name: "商品与 SKU 卡片列表" });
    const firstCard = within(cards).getAllByRole("listitem")[0]!;
    expect(
      Array.from(firstCard.querySelectorAll("[data-catalog-section]")).map(
        (section) => section.getAttribute("data-catalog-section"),
      ),
    ).toEqual([
      "identity",
      "attributes",
      "prices",
      "inventory",
      "status",
      "link",
    ]);
  });

  it.each([
    ["来源序号", "77", "TZX-WHITE-002", "TZX-034-2"],
    ["商品名称", "冬季运输防护袋", "TZX-034-2", "TZX-WHITE-002"],
    ["真实规格", longSpecification, "TZX-034-2", "TZX-WHITE-002"],
    ["SKU 编码", "TZX-034-2", "TZX-034-2", "TZX-WHITE-002"],
  ])("filters the admin catalog by %s", (_mode, query, expectedSku, excludedSku) => {
    render(
      <CatalogWorkspace
        actions={{
          createAlias: successfulAction,
          createSku: successfulAction,
          setCustomerPrice: successfulAction,
        }}
        customers={[]}
        rows={adminRows}
        stores={[]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });

    const desktopTable = screen.getByRole("table", {
      name: "商品与 SKU 列表",
    });
    expect(within(desktopTable).getByText(expectedSku)).toBeVisible();
    expect(within(desktopTable).queryByText(excludedSku)).not.toBeInTheDocument();
  });

  it.each([
    ["JavaScript scheme", "javascript:alert(document.domain)"],
    ["FTP scheme", "ftp://example.test/products/34"],
    ["relative URL", "/products/34"],
    ["malformed value", "not a url"],
    ["structurally invalid HTTPS URL", "https://"],
  ])("does not render an unsafe %s product link", (_case, productUrl) => {
    render(
      <CatalogWorkspace
        actions={{
          createAlias: successfulAction,
          createSku: successfulAction,
          setCustomerPrice: successfulAction,
        }}
        customers={[]}
        rows={[{ ...adminRows[0]!, productUrl }]}
        stores={[]}
      />,
    );

    const desktopTable = screen.getByRole("table", {
      name: "商品与 SKU 列表",
    });
    const cards = screen.getByRole("list", { name: "商品与 SKU 卡片列表" });
    expect(within(desktopTable).queryByRole("link")).not.toBeInTheDocument();
    expect(within(cards).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getAllByText("链接不可用")).toHaveLength(2);
  });

  it("renders true customer-safe catalog facts and all availability states", () => {
    render(
      <CustomerCatalogWorkspace
        items={customerRows}
        query=""
      />,
    );

    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.getAllByText("¥7.60")).toHaveLength(2);
    expect(screen.getAllByText("可售")).toHaveLength(2);
    expect(screen.getAllByText("不可售")).toHaveLength(2);
    expect(screen.getAllByText("售罄")).toHaveLength(2);
    expect(screen.getAllByText(longSpecification)).toHaveLength(2);
    expect(screen.queryByText("SKU 名称不能冒充规格")).not.toBeInTheDocument();
    expect(screen.getAllByText("颜色：炭黑")).toHaveLength(2);
    expect(screen.getAllByText("组合销售：10 件组合装")).toHaveLength(2);
    expect(screen.getAllByText("重量：480 克")).toHaveLength(2);

    for (const specification of screen.getAllByText(longSpecification)) {
      expect(specification).toHaveClass(
        "line-clamp-2",
        "whitespace-normal",
        "break-words",
      );
    }

    const links = screen.getAllByRole("link", { name: "查看商品详情" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "https://example.test/products/available");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }

    for (const internalLabel of ["序号", "采购价", "总库存", "货品价格"]) {
      expect(screen.queryByText(internalLabel)).not.toBeInTheDocument();
    }

    const desktopTable = screen.getByRole("table", { name: "客户货盘列表" });
    expect(
      within(desktopTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["商品", "规格/属性", "实际拿货价", "可售库存", "状态", "链接"]);

    const cards = screen.getByRole("list", { name: "客户货盘卡片列表" });
    const firstCard = within(cards).getAllByRole("listitem")[0]!;
    expect(
      Array.from(firstCard.querySelectorAll("[data-customer-catalog-section]")).map(
        (section) => section.getAttribute("data-customer-catalog-section"),
      ),
    ).toEqual(["identity", "attributes", "price", "inventory", "status", "link"]);

    const manualUnavailableSurfaces = screen.getAllByTestId(
      "catalog-customer-sku-manual",
    );
    const soldOutSurfaces = screen.getAllByTestId("catalog-customer-sku-sold-out");
    expect(manualUnavailableSurfaces).toHaveLength(2);
    expect(soldOutSurfaces).toHaveLength(2);
    for (const surface of [...manualUnavailableSurfaces, ...soldOutSurfaces]) {
      expect(surface).not.toHaveAttribute("aria-disabled");
    }

    const manualUnavailableLinks = screen.getAllByRole("link", {
      name: "人工不可售商品",
    });
    expect(manualUnavailableLinks).toHaveLength(2);
    for (const link of manualUnavailableLinks) {
      expect(link).toHaveAttribute("href", "https://example.test/products/manual");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
    expect(
      screen.queryByRole("button", { name: /下单|加入拿货单/ }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-customer-catalog-cards]")).not.toBeNull();
    expect(document.querySelector("[data-customer-catalog-table]")).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("matches customer catalog search only against normalized safe fields", () => {
    const item = {
      ...customerRows[0]!,
      cargoUnitPriceMilliYuan: 1_366,
      defaultUnitPriceMilliYuan: 325,
      linkText: "SAFE-LINK-TEXT",
      productName: "Demo Cable",
      sourceSequence: "ADMIN-SOURCE-34",
      specification: "WINTER SPEC VALUE",
      totalQuantity: 99,
    };

    expect(matchesCustomerCatalogQuery(item, "  tzx-customer-001  ")).toBe(true);
    expect(matchesCustomerCatalogQuery(item, "  demo cable  ")).toBe(true);
    expect(matchesCustomerCatalogQuery(item, "  winter spec  ")).toBe(true);
    expect(matchesCustomerCatalogQuery(item, "  safe-link  ")).toBe(true);
    expect(matchesCustomerCatalogQuery(item, "SKU 名称不能冒充规格")).toBe(false);
    expect(matchesCustomerCatalogQuery(item, "ADMIN-SOURCE-34")).toBe(false);
    expect(matchesCustomerCatalogQuery(item, "1366")).toBe(false);
    expect(matchesCustomerCatalogQuery(item, "99")).toBe(false);
  });

  it.each([
    ["JavaScript scheme", "javascript:alert(document.domain)"],
    ["FTP scheme", "ftp://example.test/products/customer"],
    ["relative URL", "/products/customer"],
    ["malformed value", "not a url"],
  ])("does not render an unsafe customer %s product link", (_case, productUrl) => {
    render(
      <CustomerCatalogWorkspace
        items={[{ ...customerRows[0]!, productUrl }]}
        query=""
      />,
    );

    const desktopTable = screen.getByRole("table", { name: "客户货盘列表" });
    const cards = screen.getByRole("list", { name: "客户货盘卡片列表" });
    expect(within(desktopTable).queryByRole("link")).not.toBeInTheDocument();
    expect(within(cards).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getAllByText("链接不可用")).toHaveLength(2);
  });

  it("renders protected catalog asset URLs through the image component", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          {
            actualUnitPriceFen: 760,
            actualUnitPriceMilliYuan: 7_600,
            availabilityReason: "AVAILABLE",
            availableQuantity: 6,
            color: null,
            combination: null,
            id: "sku-1",
            imageUrl: "/api/catalog-assets/asset-1",
            linkText: null,
            orderable: true,
            productName: "Demo Cable",
            productUrl: null,
            saleStatus: "SELLABLE",
            sellable: true,
            skuCode: "TZX-DEMO-001",
            skuName: "Black 10-pack",
            specification: "Black",
            weightGrams: null,
          },
        ]}
        query=""
      />,
    );

    const images = screen.getAllByRole("img", { name: "Demo Cable 商品图片" });
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toHaveAttribute("src", "/api/catalog-assets/asset-1");
    }
  });
});
