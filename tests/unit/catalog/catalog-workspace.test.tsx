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
import type { CustomerCatalogItem } from "@/modules/catalog/customer-catalog";
import * as productGroups from "@/modules/catalog/product-groups";
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

const catalogActions = {
  batchManage: successfulAction,
  createAlias: successfulAction,
  createSku: successfulAction,
  deleteSku: successfulAction,
  restoreSku: successfulAction,
  updateProduct: successfulAction,
  updateSku: successfulAction,
};

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
    productId: "product-34",
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
    productId: "product-77",
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

const groupedAdminRows: AdminCatalogItem[] = [
  "1",
  "2",
  "3",
].map((variant, index) => ({
  ...adminRows[0]!,
  cargoUnitPriceMilliYuan: (index + 1) * 1_000,
  id: `sku-001-${variant}`,
  productId: "product-001",
  productName: "三规格货品",
  skuCode: `TZX-001-${variant}`,
  sourceSequence: "1",
}));

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
    productId: "customer-product-available",
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
    productId: "customer-product-manual",
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
    productId: "customer-product-sold-out",
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

const groupedCustomerRows: CustomerCatalogItem[] = ["1", "2", "3"].map(
  (variant) => ({
    ...customerRows[0]!,
    id: `customer-group-sku-${variant}`,
    productId: "customer-group-product",
    productName: "三规格客户货品",
    productUrl: `https://example.test/products/customer-group-${variant}`,
    skuCode: `TZX-CUSTOMER-GROUP-00${variant}`,
  }),
);

afterEach(() => {
  cleanup();
});

describe("catalog workspaces", () => {
  it("groups source product variants and keeps every sibling when one SKU matches search", () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
        rows={groupedAdminRows}
        stores={[]}
      />,
    );

    const desktopTable = screen.getByRole("table", { name: "商品与 SKU 列表" });
    expect(within(desktopTable).getByText("1", { exact: true })).toBeVisible();
    expect(within(desktopTable).queryByText("序号 1", { exact: true })).not.toBeInTheDocument();
    for (const price of ["¥1.00", "¥2.00", "¥3.00"]) {
      expect(within(desktopTable).getByText(price, { exact: true })).toBeVisible();
    }
    for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
      expect(screen.getAllByText(skuCode)).toHaveLength(2);
      for (const sku of screen.getAllByText(skuCode)) expect(sku).toBeVisible();
    }
    expect(screen.getByText("1 个商品 / 3 个 SKU")).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "TZX-001-2" },
    });

    for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
      expect(screen.getAllByText(skuCode)).toHaveLength(2);
      for (const sku of screen.getAllByText(skuCode)) expect(sku).toBeVisible();
    }

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "重量：480" },
    });

    for (const skuCode of ["TZX-001-1", "TZX-001-2", "TZX-001-3"]) {
      expect(screen.getAllByText(skuCode)).toHaveLength(2);
      for (const sku of screen.getAllByText(skuCode)) expect(sku).toBeVisible();
    }
  });

  it("filters administrator catalog variants by sale status after preserving search siblings", () => {
    const mixedStatusRows: AdminCatalogItem[] = [
      { ...adminRows[0]!, id: "sku-001-1", productId: "product-001", productName: "混合状态货品", skuCode: "TZX-001-1", sourceSequence: "1", saleStatus: "SELLABLE" },
      { ...adminRows[0]!, id: "sku-001-2", productId: "product-001", productName: "混合状态货品", skuCode: "TZX-001-2", sourceSequence: "1", saleStatus: "NOT_SELLABLE" },
      { ...adminRows[1]!, id: "sku-002", productId: "product-002", productName: "仅不可售货品", skuCode: "TZX-002", sourceSequence: "2", saleStatus: "NOT_SELLABLE" },
    ];
    render(
      <CatalogWorkspace
        actions={catalogActions}
        rows={mixedStatusRows}
        stores={[]}
      />,
    );

    const statusFilter = screen.getByRole("group", { name: "销售状态筛选" });
    for (const [name, label, pressed] of [
      ["查看全部 SKU", "全部", "true"],
      ["只看可售 SKU", "可售", "false"],
      ["只看不可售 SKU", "不可售", "false"],
    ] as const) {
      const button = within(statusFilter).getByRole("button", { name });
      expect(button).toBeVisible();
      expect(button).toHaveTextContent(label);
      expect(button).toHaveAttribute("aria-pressed", pressed);
    }

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "TZX-001-1" } });
    expect(screen.getAllByText("TZX-001-1")).toHaveLength(2);
    expect(screen.getAllByText("TZX-001-2")).toHaveLength(2);

    fireEvent.click(within(statusFilter).getByRole("button", { name: "只看可售 SKU" }));
    expect(screen.getAllByText("TZX-001-1")).toHaveLength(2);
    expect(screen.queryByText("TZX-001-2")).not.toBeInTheDocument();
    expect(screen.getByText("1 个商品 / 1 个 SKU")).toBeVisible();

    fireEvent.click(within(statusFilter).getByRole("button", { name: "只看不可售 SKU" }));
    expect(screen.getAllByText("TZX-001-2")).toHaveLength(2);
    expect(screen.queryByText("TZX-001-1")).not.toBeInTheDocument();
  });

  it("clears combined administrator query and sale-status filters locally from the empty state", () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
        rows={[adminRows[0]!]}
        stores={[]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no admin SKU matches this query" } });
    fireEvent.click(screen.getByRole("button", { name: "只看不可售 SKU" }));

    expect(screen.getByRole("heading", { name: "没有符合条件的 SKU" })).toBeVisible();

    const clearFilters = screen.getByRole("button", { name: "清除筛选" });
    fireEvent.click(clearFilters);

    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByText("1 个商品 / 1 个 SKU")).toBeVisible();
    expect(screen.getAllByText("TZX-034-2")).toHaveLength(2);
  });

  it("keeps catalog mutations out of the resource list until their drawers open", async () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
        rows={[adminRows[0]!]}
        stores={[{ id: "store-1", name: "Temu North" }]}
      />,
    );

    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.queryByRole("button", { name: "设置客户价" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建 SKU" }));

    const createDrawer = await screen.findByRole("dialog");
    fireEvent.change(within(createDrawer).getByLabelText("创建方式"), {
      target: { value: "CREATE" },
    });
    for (const field of [
      "序号",
      "商品名称",
      "货品价格（元）",
      "链接文字",
      "SKU",
      "图片",
      "采购价（元）",
      "初始库存（份）",
      "链接地址",
      "规格",
      "颜色",
      "组合销售",
      "重量（克）",
      "销售状态",
      "创建原因",
    ]) {
      expect(
        within(createDrawer).getByLabelText(field === "图片" ? /^图片/ : field),
      ).toBeVisible();
    }
    const submitButton = within(createDrawer)
      .getAllByRole("button")
      .find((button) => button.getAttribute("type") === "submit");
    expect(submitButton).toBeEnabled();
  });

  it("exposes per-SKU management and enables batch management after selection", async () => {
    render(<CatalogWorkspace actions={catalogActions} rows={[adminRows[0]!]} stores={[]} />);

    expect(screen.getByRole("button", { name: "批量管理 SKU" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择 TZX-034-2" })[0]!);
    expect(screen.getByRole("button", { name: "批量管理 SKU (1)" })).toBeEnabled();

    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]!);
    const drawer = await screen.findByRole("dialog", { name: "管理 TZX-034-2" });
    expect(within(drawer).getByRole("heading", { name: "商品资料（同组共享）" })).toBeVisible();
    expect(within(drawer).getByRole("heading", { name: "SKU 资料" })).toBeVisible();
    expect(within(drawer).getByLabelText("商品名称")).toHaveValue("冬季运输防护袋");
    expect(within(drawer).getByLabelText("货品价格（元）")).toHaveValue("1.366");
    expect(within(drawer).getByLabelText("SKU")).toHaveValue("TZX-034-2");
    expect(within(drawer).getByRole("button", { name: "确认删除 SKU" })).toBeVisible();
  });

  it("renders a missing purchase price as empty and requires an administrator to fill it before saving", async () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
        rows={[{ ...adminRows[1]!, defaultUnitPriceMilliYuan: null }]}
        stores={[]}
      />,
    );

    const desktopTable = screen.getByRole("table", { name: "商品与 SKU 列表" });
    expect(within(desktopTable).getAllByText("—").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]!);
    const drawer = await screen.findByRole("dialog", { name: "管理 TZX-WHITE-002" });
    const purchasePrice = within(drawer).getByLabelText("采购价（元）");
    expect(purchasePrice).toHaveValue("");
    expect(purchasePrice).toBeRequired();
    const weight = within(drawer).getByLabelText("重量（克）");
    expect(weight).toHaveValue(null);
    expect(weight).toBeRequired();
  });

  it("lets administrators restore an archived SKU without exposing active-only operations", async () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
        lifecycle="ARCHIVED"
        rows={[{
          ...adminRows[0]!,
          archiveReason: "历史订单已结束",
          lifecycleStatus: "ARCHIVED",
          saleStatus: "NOT_SELLABLE",
        }]}
        stores={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: /新建 SKU/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量管理 SKU/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "管理" })[0]!);
    expect(await screen.findByText("归档原因：历史订单已结束")).toBeVisible();
    expect(screen.getByLabelText("恢复原因")).toBeVisible();
    expect(screen.getByRole("button", { name: "恢复 SKU" })).toBeVisible();
  });

  it("renders the complete admin field mapping in a semantic table and ordered cards", () => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
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
      "",
      "序号",
      "商品",
      "SKU",
      "规格/属性",
      "采购价",
      "总库存",
      "可售库存",
      "货品价格",
      "状态",
      "SKU 链接",
      "操作",
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
    expect(within(firstCard).getByRole("list", {
      name: "冬季运输防护袋 的 SKU 列表",
    })).toBeVisible();
  });

  it.each([
    ["来源序号", "77", "TZX-WHITE-002", "TZX-034-2"],
    ["商品名称", "冬季运输防护袋", "TZX-034-2", "TZX-WHITE-002"],
    ["真实规格", longSpecification, "TZX-034-2", "TZX-WHITE-002"],
    ["SKU 编码", "TZX-034-2", "TZX-034-2", "TZX-WHITE-002"],
  ])("filters the admin catalog by %s", (_mode, query, expectedSku, excludedSku) => {
    render(
      <CatalogWorkspace
        actions={catalogActions}
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
        actions={catalogActions}
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

    expect(screen.getByRole("heading", { name: "实时货盘" })).toBeVisible();
    expect(screen.getByText("库存实时更新")).toBeVisible();
    expect(screen.getByRole("searchbox")).toBeVisible();
    const results = within(screen.getByTestId("customer-catalog-results"));
    expect(results.getAllByText("¥7.60")).toHaveLength(2);
    expect(results.getAllByText("可售")).toHaveLength(2);
    expect(results.getAllByText("不可售")).toHaveLength(2);
    expect(results.getAllByText("售罄")).toHaveLength(2);
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

    const desktopTable = screen.getByRole("table", {
      name: "冬季运输防护袋 的 SKU 列表",
    });
    expect(
      within(desktopTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["SKU", "规格/属性", "拿货价", "可售库存", "状态", "链接"]);

    const cards = screen.getByRole("list", { name: "客户货盘卡片列表" });
    expect(
      within(cards)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "冬季运输防护袋",
      "人工暂停销售商品",
      "暂时售罄商品",
    ]);
    const firstVariant = within(cards).getByTestId("catalog-customer-sku-manual");
    expect(
      Array.from(firstVariant.querySelectorAll("[data-customer-catalog-section]")).map(
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
    expect(screen.getByRole("combobox", { name: "货盘排序方式" })).toBeVisible();
  });

  it("groups customer SKU variants and retains sibling variants for a one-SKU search", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          ...groupedCustomerRows,
          { ...customerRows[1]!, productName: "另一件客户货品" },
        ]}
        query="TZX-CUSTOMER-GROUP-002"
      />,
    );

    expect(screen.getByText("1 个商品 / 3 个 SKU")).toBeVisible();
    expect(screen.queryByText("另一件客户货品")).not.toBeInTheDocument();

    const desktopGroup = screen
      .getAllByTestId("catalog-product-customer-group-product")
      .find((element) => element.tagName === "SECTION");
    expect(desktopGroup).toBeDefined();
    expect(within(desktopGroup!).getByRole("heading", { name: "三规格客户货品" })).toBeVisible();
    const desktopTable = within(desktopGroup!).getByRole("table", {
      name: "三规格客户货品 的 SKU 列表",
    });
    for (const skuCode of [
      "TZX-CUSTOMER-GROUP-001",
      "TZX-CUSTOMER-GROUP-002",
      "TZX-CUSTOMER-GROUP-003",
    ]) {
      expect(within(desktopTable).getByText(skuCode)).toBeVisible();
    }

    expect(desktopGroup!.textContent).not.toContain("sourceSequence");
    expect(desktopGroup!.textContent).not.toContain("采购价");
    expect(desktopGroup!.textContent).not.toContain("总库存");
    expect(desktopGroup!.textContent).not.toContain("货品价格");
  });

  it("opens an accessible large preview when a customer selects a SKU image", () => {
    render(<CustomerCatalogWorkspace items={[customerRows[0]!]} query="" />);

    const triggers = screen.getAllByRole("button", {
      name: "查看 冬季运输防护袋 大图",
    });
    expect(triggers).toHaveLength(2);

    fireEvent.click(triggers[0]!);

    const dialog = screen.getByRole("dialog", { name: "冬季运输防护袋 图片预览" });
    expect(within(dialog).getByRole("img", { name: "冬季运输防护袋 大图" })).toHaveAttribute(
      "src",
      "/api/catalog-assets/asset-available",
    );
    expect(within(dialog).getByRole("button", { name: "关闭图片预览" })).toBeVisible();
  });

  it("shows a missing cargo price as unavailable instead of falling back to purchase price", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          {
            ...customerRows[0]!,
            actualUnitPriceFen: null,
            actualUnitPriceMilliYuan: null,
            availabilityReason: "PRICE_MISSING",
            id: "customer-price-missing",
            orderable: false,
          },
        ]}
        query=""
      />,
    );

    const results = within(screen.getByTestId("customer-catalog-results"));
    expect(results.getAllByText("价格待维护")).toHaveLength(4);
    expect(screen.queryByText("实际拿货价")).not.toBeInTheDocument();
  });

  it("defaults customer products to SKU order and offers price sorting", () => {
    const sortableRows: CustomerCatalogItem[] = [
      {
        ...customerRows[0]!,
        actualUnitPriceMilliYuan: 2_000,
        id: "sortable-053",
        productId: "sortable-product-053",
        productName: "PP塑料吸管",
        skuCode: "TZX-053",
      },
      {
        ...customerRows[0]!,
        actualUnitPriceMilliYuan: 1_350,
        id: "sortable-034",
        productId: "sortable-product-034",
        productName: "A4文件袋",
        skuCode: "TZX-034-1",
      },
      {
        ...customerRows[0]!,
        actualUnitPriceMilliYuan: 3_100,
        id: "sortable-037",
        productId: "sortable-product-037",
        productName: "USB数据线",
        skuCode: "TZX-037-1",
      },
    ];

    render(<CustomerCatalogWorkspace items={sortableRows} query="" />);

    const desktopProductNames = () =>
      Array.from(
        screen
          .getByTestId("customer-catalog-results")
          .querySelectorAll("[data-customer-catalog-table] > section h3"),
      ).map((heading) => heading.textContent);

    expect(screen.getByRole("combobox", { name: "货盘排序方式" })).toHaveTextContent(
      "SKU 顺序",
    );
    expect(desktopProductNames()).toEqual(["A4文件袋", "USB数据线", "PP塑料吸管"]);

    fireEvent.click(screen.getByRole("combobox", { name: "货盘排序方式" }));
    fireEvent.click(screen.getByRole("option", { name: "货价：从高到低" }));
    expect(desktopProductNames()).toEqual(["USB数据线", "PP塑料吸管", "A4文件袋"]);

    fireEvent.click(screen.getByRole("combobox", { name: "货盘排序方式" }));
    fireEvent.click(screen.getByRole("option", { name: "货价：从低到高" }));
    expect(desktopProductNames()).toEqual(["A4文件袋", "PP塑料吸管", "USB数据线"]);
  });

  it("filters customer catalog variants by availability while retaining detailed unavailable reasons", () => {
    const mixedAvailabilityRows: CustomerCatalogItem[] = [
      {
        ...customerRows[0]!,
        id: "customer-availability-available",
        productId: "customer-availability-product",
        productName: "客户可售状态货品",
        skuCode: "TZX-034-1",
      },
      {
        ...customerRows[1]!,
        id: "customer-availability-manual",
        productId: "customer-availability-product",
        productName: "客户可售状态货品",
        skuCode: "TZX-034-2",
      },
      {
        ...customerRows[2]!,
        id: "customer-availability-sold-out",
        productId: "customer-availability-product",
        productName: "客户可售状态货品",
        skuCode: "TZX-034-3",
      },
    ];

    render(<CustomerCatalogWorkspace items={mixedAvailabilityRows} query="" />);

    expect(screen.getByRole("group", { name: "销售状态筛选" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "只看不可售 SKU" }));

    expect(screen.queryByText("TZX-034-1")).not.toBeInTheDocument();
    expect(screen.getAllByText("TZX-034-2")).toHaveLength(2);
    expect(screen.getAllByText("TZX-034-3")).toHaveLength(2);
    expect(screen.getByText("1 个商品 / 2 个 SKU")).toBeVisible();
    const results = within(screen.getByTestId("customer-catalog-results"));
    expect(results.getAllByText("不可售")).toHaveLength(2);
    expect(results.getAllByText("售罄")).toHaveLength(2);

    for (const internalLabel of ["序号", "采购价", "总库存", "货品价格"]) {
      expect(screen.queryByText(internalLabel)).not.toBeInTheDocument();
    }
  });

  it("clears a no-result customer query and availability filter locally", () => {
    render(<CustomerCatalogWorkspace items={customerRows} query="no customer SKU matches this query" />);

    fireEvent.click(screen.getByRole("button", { name: "只看可售 SKU" }));
    expect(screen.getByRole("heading", { name: "没有符合条件的 SKU" })).toBeVisible();

    const clearFilters = screen.getByRole("button", { name: "清除筛选" });
    expect(clearFilters.closest("a")).toBeNull();
    fireEvent.click(clearFilters);

    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByText("3 个商品 / 3 个 SKU")).toBeVisible();
    expect(within(screen.getByTestId("customer-catalog-results")).getAllByText("可售")).toHaveLength(2);
  });

  it("does not rebuild customer grouping and search results until the draft query is submitted", () => {
    const groupSpy = vi.spyOn(productGroups, "groupCatalogItems");
    const searchSpy = vi.spyOn(productGroups, "filterCatalogGroups");

    render(<CustomerCatalogWorkspace items={customerRows} query="" />);

    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "draft only" } });

    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "搜索货盘" }));

    expect(groupSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives duplicate customer product names distinct table names without exposing source sequence", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          ...groupedCustomerRows,
          {
            ...customerRows[1]!,
            productId: "customer-group-product-duplicate-name",
            productName: "三规格客户货品",
            skuCode: "TZX-CUSTOMER-GROUP-004",
          },
        ]}
        query=""
      />,
    );

    const tableNames = screen
      .getAllByRole("table")
      .map((table) => table.getAttribute("aria-label"));
    expect(tableNames).toHaveLength(2);
    expect(new Set(tableNames).size).toBe(2);
    expect(tableNames.join(" ")).not.toContain("sourceSequence");
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

    const desktopTable = screen.getByRole("table", { name: "冬季运输防护袋 的 SKU 列表" });
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
            productId: "demo-product",
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
