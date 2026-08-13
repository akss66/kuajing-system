// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CatalogWorkspace,
  CustomerCatalogWorkspace,
} from "@/components/catalog/catalog-workspace";
import type { ManagedAction } from "@/shared/action-state";

const successfulAction: ManagedAction = async () => ({ status: "success" });

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
        rows={[
          {
            id: "sku-1",
            name: "黑色 10 件装",
            price: 690,
            productName: "演示头绳",
            saleStatus: "SELLABLE",
            skuCode: "TZX-DEMO-001",
          },
        ]}
        stores={[{ id: "store-1", name: "TEMU 北区店" }]}
      />,
    );

    expect(screen.getByRole("searchbox", { name: "搜索商品与 SKU" })).toBeVisible();
    expect(screen.queryByLabelText("标准 SKU")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("专属价客户")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("别名店铺")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建 SKU" }));
    const createDrawer = await screen.findByRole("dialog", { name: "新建 SKU" });
    expect(within(createDrawer).getByLabelText("标准 SKU")).toBeVisible();
    expect(within(createDrawer).getByRole("button", { name: "创建 SKU" })).toBeEnabled();
  });

  it("filters the admin catalog by product name, specification, or SKU", () => {
    render(
      <CatalogWorkspace
        actions={{
          createAlias: successfulAction,
          createSku: successfulAction,
          setCustomerPrice: successfulAction,
        }}
        customers={[]}
        rows={[
          {
            id: "sku-1",
            name: "黑色 10 件装",
            price: 690,
            productName: "演示头绳",
            saleStatus: "SELLABLE",
            skuCode: "TZX-DEMO-001",
          },
          {
            id: "sku-2",
            name: "白色 20 件装",
            price: 990,
            productName: "日常发圈",
            saleStatus: "DISABLED",
            skuCode: "TZX-WHITE-002",
          },
        ]}
        stores={[]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索商品与 SKU" }), {
      target: { value: "WHITE" },
    });

    const desktopTable = screen.getByRole("table", { name: "商品与 SKU 列表" });
    expect(within(desktopTable).queryByText("TZX-DEMO-001")).not.toBeInTheDocument();
    expect(within(desktopTable).getByText("TZX-WHITE-002")).toBeVisible();
  });

  it("keeps customer search first and presents isolated actual price and available stock", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          {
            actualUnitPriceFen: 760,
            availableQuantity: 6,
            id: "sku-1",
            imageUrl: null,
            productName: "演示头绳",
            sellable: true,
            skuCode: "TZX-DEMO-001",
            skuName: "黑色 10 件装",
            specification: "黑色",
          },
        ]}
        query=""
      />,
    );

    expect(screen.getByRole("searchbox", { name: "搜索 SKU 或商品名称" })).toBeVisible();
    expect(screen.getByTestId("customer-catalog-results")).toHaveTextContent("¥7.60");
    expect(screen.getByTestId("customer-catalog-results")).toHaveTextContent("可售 6");
    expect(document.querySelector("[data-customer-catalog-cards]")).not.toBeNull();
    expect(document.querySelector("[data-customer-catalog-table]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /加入|购物车|下单/ })).not.toBeInTheDocument();
  });
});
