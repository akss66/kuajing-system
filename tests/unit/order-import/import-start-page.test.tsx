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

  it("starts the same four-stage flow at store and file selection", async () => {
    render(await NewTemuImportPage());

    const progress = screen.getByRole("navigation", { name: "订单导入进度" });
    expect(within(progress).getByText("选择店铺")).toBeVisible();
    expect(within(progress).getByText("上传文件")).toBeVisible();
    expect(within(progress).getByText("校验预览")).toBeVisible();
    expect(within(progress).getByText("确认提交")).toBeVisible();
    expect(within(progress).getByText("上传文件").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });
});
