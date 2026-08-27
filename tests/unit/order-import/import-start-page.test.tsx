// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const storeMocks = vi.hoisted(() => ({ listActiveCustomerStores: vi.fn() }));

vi.mock("@/modules/identity/guards", () => identityMocks);
vi.mock("@/modules/order-import/service", () => storeMocks);
vi.mock("@/modules/order-import/actions", () => ({ uploadTemuOrdersAction: vi.fn() }));
vi.mock("@/components/order-import/temu-upload-form", () => ({
  TemuUploadForm: () => <form aria-label="TEMU 上传表单" />,
}));

import NewTemuImportPage from "@/app/(customer)/portal/imports/new/page";

describe("NewTemuImportPage", () => {
  beforeEach(() => {
    identityMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1" });
    storeMocks.listActiveCustomerStores.mockResolvedValue([
      { id: "store-1", name: "TEMU 一店", platform: "TEMU" },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts directly at store and file selection without a decorative progress bar", async () => {
    render(await NewTemuImportPage());

    expect(screen.queryByRole("navigation", { name: "订单导入进度" })).not.toBeInTheDocument();
    const routePicker = screen.getByRole("region", { name: "上传路径" });
    expect(within(routePicker).getByText("单店铺上传")).toBeVisible();
    expect(within(routePicker).getByRole("link", { name: /多店铺批量上传/ })).toHaveAttribute(
      "href",
      "/portal/bulk-orders",
    );
    expect(screen.getByRole("link", { name: "先查看实时货盘" })).toHaveAttribute(
      "href",
      "/portal/catalog",
    );
    expect(screen.getByText("开始上传")).toBeVisible();
  });
});
