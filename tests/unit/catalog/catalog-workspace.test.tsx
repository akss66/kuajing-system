// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogWorkspace,
  CustomerCatalogWorkspace,
} from "@/components/catalog/catalog-workspace";
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
            name: "Black 10-pack",
            price: 690,
            priceMilliYuan: 6_900,
            productName: "Demo Cable",
            saleStatus: "SELLABLE",
            skuCode: "TZX-DEMO-001",
          },
        ]}
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
            name: "Black 10-pack",
            price: 690,
            priceMilliYuan: 6_900,
            productName: "Demo Cable",
            saleStatus: "SELLABLE",
            skuCode: "TZX-DEMO-001",
          },
          {
            id: "sku-2",
            name: "White 20-pack",
            price: 990,
            priceMilliYuan: 9_900,
            productName: "Daily Hair Tie",
            saleStatus: "DISABLED",
            skuCode: "TZX-WHITE-002",
          },
        ]}
        stores={[]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "WHITE" },
    });

    const desktopTable = screen.getByRole("table");
    expect(within(desktopTable).queryByText("TZX-DEMO-001")).not.toBeInTheDocument();
    expect(within(desktopTable).getByText("TZX-WHITE-002")).toBeVisible();
  });

  it("keeps customer search first and presents isolated actual price and available stock", () => {
    render(
      <CustomerCatalogWorkspace
        items={[
          {
            actualUnitPriceFen: 760,
            actualUnitPriceMilliYuan: 7_600,
            availableQuantity: 6,
            id: "sku-1",
            imageUrl: null,
            productName: "Demo Cable",
            sellable: true,
            skuCode: "TZX-DEMO-001",
            skuName: "Black 10-pack",
            specification: "Black",
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
            availableQuantity: 6,
            id: "sku-1",
            imageUrl: "/api/catalog-assets/asset-1",
            productName: "Demo Cable",
            sellable: true,
            skuCode: "TZX-DEMO-001",
            skuName: "Black 10-pack",
            specification: "Black",
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
