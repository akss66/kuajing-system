import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  revalidatePath: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const submissionMocks = vi.hoisted(() => ({
  submitTemuImportBatch: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/orders/submission", () => ({
  OrderSubmissionError: class OrderSubmissionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "OrderSubmissionError";
    }
  },
  submitTemuImportBatch: submissionMocks.submitTemuImportBatch,
}));

import { submitImportBatchAction } from "@/modules/orders/actions";
import { OrderSubmissionError } from "@/modules/orders/submission";

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

  it.each(["SKU_NOT_SELLABLE", "INSUFFICIENT_INVENTORY"] as const)(
    "refreshes the preview when submission reclassifies rows as %s",
    async (code) => {
      submissionMocks.submitTemuImportBatch.mockRejectedValueOnce(
        new OrderSubmissionError(code, "请重新检查导入明细"),
      );
      const formData = new FormData();
      formData.set("batchId", "11111111-1111-4111-8111-111111111111");

      const result = await submitImportBatchAction({ status: "idle" }, formData);

      expect(result).toEqual({ status: "error", message: "请重新检查导入明细" });
      expect(cacheMocks.refresh).toHaveBeenCalledTimes(1);
    },
  );
});
