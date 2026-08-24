// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const previewMocks = vi.hoisted(() => ({
  ImportPreviewError: class ImportPreviewError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "ImportPreviewError";
    }
  },
  getCustomerImportPreview: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/order-import/service", () => {
  return {
    ImportPreviewError: previewMocks.ImportPreviewError,
    getCustomerImportPreview: previewMocks.getCustomerImportPreview,
  };
});
vi.mock("@/components/orders/order-submit-button", () => ({
  OrderSubmitButton: ({ disabled }: { disabled: boolean }) => (
    <button disabled={disabled} type="button">
      提交订单
    </button>
  ),
}));
vi.mock("@/modules/orders/actions", () => ({
  submitImportBatchAction: vi.fn(),
}));
vi.mock("@/modules/order-import/actions", () => ({
  updateCustomerImportRowAction: vi.fn(),
}));

import ImportPreviewPage from "@/app/(customer)/portal/imports/[batchId]/page";

describe("ImportPreviewPage", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockReset();
    previewMocks.getCustomerImportPreview.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses a compact review workspace with an always-visible submit bar", async () => {
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
    previewMocks.getCustomerImportPreview.mockResolvedValue({
      batchId: "batch-1",
      expiresAt: new Date("2026-08-13T10:00:00.000Z"),
      fileName: "orders.xlsx",
      rows: [
        {
          effectiveQuantity: 1,
          id: "row-1",
          errorCode: null,
          errorMessage: null,
          externalOrderNo: "PO-1",
          externalSku: "SKU-1",
          externalSubOrderNo: "SUB-1",
          fulfillmentMode: "SYSTEM_SKU",
          quantity: 1,
          quantityMultiplier: 1,
          resolutionMethod: "EXACT",
          resolvedSku: { id: "sku-1", name: "商品 1", skuCode: "SKU-1" },
          revision: 1,
          rowNumber: 2,
          siblingCandidates: [
            { availableQuantity: 10, id: "sku-1", name: "商品 1", skuCode: "SKU-1" },
          ],
          status: "READY",
        },
      ],
      storeId: "store-1",
      storeName: "TEMU 店铺",
      summary: {
        duplicate: 2,
        invalid: 4,
        ready: 8,
        total: 15,
        unknownSku: 1,
      },
    });

    render(
      await ImportPreviewPage({
        params: Promise.resolve({ batchId: "batch-1" }),
      }),
    );

    const progress = screen.getByRole("navigation", { name: "订单导入进度" });
    const workspace = screen.getByRole("region", { name: "逐行校验工作台" });
    const submitBar = screen.getByRole("region", { name: "提交拿货单操作栏" });

    expect(screen.getByRole("link", { name: "返回重新上传" })).toBeVisible();
    expect(within(progress).getByText("选择店铺")).toBeVisible();
    expect(within(progress).getByText("上传文件")).toBeVisible();
    expect(within(progress).getByText("校验预览")).toBeVisible();
    expect(within(progress).getByText("确认提交")).toBeVisible();
    expect(within(progress).getByText("校验预览").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText(/TEMU 店铺.*orders\.xlsx.*15 行/)).toBeVisible();
    expect(workspace).toHaveTextContent("逐行校验");
    expect(workspace).toHaveTextContent("可提交1");
    expect(workspace).toHaveTextContent("需处理0");
    expect(workspace).toHaveTextContent("重复跳过0");
    expect(within(workspace).getByRole("table", { name: "逐行校验结果" })).toBeVisible();
    expect(submitBar).toHaveClass("sticky");
    expect(within(submitBar).getByRole("button", { name: "提交订单" })).toBeDisabled();
  });

  it("explains that customers can resolve unavailable SKUs before submission", async () => {
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
    previewMocks.getCustomerImportPreview.mockResolvedValue({
      batchId: "batch-1",
      expiresAt: new Date("2026-08-13T10:00:00.000Z"),
      fileName: "orders.xlsx",
      rows: [
        {
          effectiveQuantity: 1,
          id: "row-1",
          errorCode: "SKU_UNAVAILABLE",
          errorMessage: "SKU 已下架或不可售，请联系管理员处理",
          externalOrderNo: "PO-1",
          externalSku: "SKU-1",
          externalSubOrderNo: "SUB-1",
          fulfillmentMode: "SYSTEM_SKU",
          quantity: 1,
          quantityMultiplier: 1,
          resolutionMethod: "EXACT",
          resolvedSku: null,
          revision: 1,
          rowNumber: 2,
          siblingCandidates: [],
          status: "UNKNOWN_SKU",
        },
      ],
      storeId: "store-1",
      storeName: "TEMU 店铺",
      summary: {
        duplicate: 0,
        invalid: 0,
        ready: 0,
        total: 1,
        unknownSku: 1,
      },
    });

    render(
      await ImportPreviewPage({
        params: Promise.resolve({ batchId: "batch-1" }),
      }),
    );

    expect(screen.getAllByText("需处理").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/选择同系列替代 SKU、手动输入或调整数量/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/联系管理员处理/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交订单" })).toBeDisabled();
  });
});
