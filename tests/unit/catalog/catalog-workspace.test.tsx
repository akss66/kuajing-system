// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogWorkspace,
  CustomerCatalogWorkspace,
} from "@/components/catalog/catalog-workspace";
import type { AdminCatalogItem } from "@/modules/catalog/admin-catalog";
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

const successfulAction: ManagedAction = async () => ({ status: "success" });

const longSpecification =
  "适用于加拿大冬季运输场景的超长规格说明，包含加厚防护层、可重复封装结构与批次追踪标识，内容必须稳定换行且不能侵入相邻价格或库存列。";

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

  it("keeps customer search first and presents isolated actual price and available stock", () => {
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
            imageUrl: null,
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

    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.getAllByText("¥7.60")).toHaveLength(2);
    expect(screen.getByTestId("customer-catalog-results")).toHaveTextContent("6");
    expect(document.querySelector("[data-customer-catalog-cards]")).not.toBeNull();
    expect(document.querySelector("[data-customer-catalog-table]")).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
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

    const images = screen.getAllByRole("img", { name: "Demo Cable Black 10-pack" });
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toHaveAttribute("src", "/api/catalog-assets/asset-1");
    }
  });
});
