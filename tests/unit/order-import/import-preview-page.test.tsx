// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
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

import ImportPreviewPage from "@/app/(customer)/portal/imports/[batchId]/page";

describe("ImportPreviewPage", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockReset();
    previewMocks.getCustomerImportPreview.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps a visible re-upload link and renders each preview metric only once", async () => {
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
          errorCode: null,
          errorMessage: null,
          externalOrderNo: "PO-1",
          externalSku: "SKU-1",
          externalSubOrderNo: "SUB-1",
          quantity: 1,
          rowNumber: 2,
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

    const metricStrip = document.querySelector("[data-metric-strip]");
    expect(screen.getByRole("link", { name: "重新上传" })).toBeVisible();
    expect(metricStrip?.textContent).toContain("可提交");
    expect(metricStrip?.textContent).toContain("重复订单");
    expect(metricStrip?.textContent).toContain("未知 SKU");
    expect(metricStrip?.textContent).toContain("格式错误");
    expect(metricStrip?.querySelectorAll("article")).toHaveLength(4);
  });
});
