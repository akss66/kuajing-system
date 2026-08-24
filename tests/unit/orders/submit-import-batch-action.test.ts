import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  revalidatePath: vi.fn(),
}));

const inventoryMocks = vi.hoisted(() => {
  class InsufficientInventoryError extends Error {}
  return { InsufficientInventoryError };
});

const submissionMocks = vi.hoisted(() => {
  class OrderSubmissionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    OrderSubmissionError,
    submitTemuImportBatch: vi.fn(),
  };
});

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/inventory/service", () => inventoryMocks);
vi.mock("@/modules/orders/submission", () => submissionMocks);

import { submitImportBatchAction } from "@/modules/orders/actions";

describe("submitImportBatchAction", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockReset();
    cacheMocks.refresh.mockReset();
    cacheMocks.revalidatePath.mockReset();
    submissionMocks.submitTemuImportBatch.mockReset();
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
  });

  it("refreshes the preview immediately after a stale available SKU is reclassified", async () => {
    submissionMocks.submitTemuImportBatch.mockRejectedValue(
      new submissionMocks.OrderSubmissionError(
        "SKU_NOT_SELLABLE",
        "订单中有 SKU 已下架或不可售，预览已更新，请联系管理员处理",
      ),
    );
    const formData = new FormData();
    formData.set("batchId", "11111111-1111-4111-8111-111111111111");

    const result = await submitImportBatchAction({ status: "idle" }, formData);

    expect(result).toEqual({
      status: "error",
      message: "订单中有 SKU 已下架或不可售，预览已更新，请联系管理员处理",
    });
    expect(cacheMocks.refresh).toHaveBeenCalledOnce();
  });
});
