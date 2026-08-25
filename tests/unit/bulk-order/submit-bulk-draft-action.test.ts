import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  submitBulkDraft: vi.fn(),
}));

const draftServiceMocks = vi.hoisted(() => ({
  addStoreGroup: vi.fn(),
  createBulkDraft: vi.fn(),
  getBulkDraft: vi.fn(),
  removeGroupFile: vi.fn(),
  uploadGroupFiles: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/bulk-order/draft-service", () => draftServiceMocks);
vi.mock("@/modules/bulk-order/submission-service", () => ({
  ...serviceMocks,
  BulkSubmissionError: class BulkSubmissionError extends Error {},
}));

import { submitBulkDraftAction } from "@/modules/bulk-order/actions";

describe("submitBulkDraftAction", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockReset();
    cacheMocks.revalidatePath.mockReset();
    serviceMocks.submitBulkDraft.mockReset();

    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
  });

  it("rejects an invalid idempotency key before calling the submission service", async () => {
    const result = await submitBulkDraftAction({
      draftId: "draft-1",
      requestedWalletFen: 0,
      selectedGroupIds: ["group-a"],
      idempotencyKey: "not-a-uuid",
    });

    expect(result).toEqual({
      ok: false,
      message: "提交参数不完整，请刷新页面后重试。",
    });
    expect(serviceMocks.submitBulkDraft).not.toHaveBeenCalled();
  });

  it("passes the provided client key through replayed submissions", async () => {
    serviceMocks.submitBulkDraft.mockImplementation(async ({ idempotencyKey }) => ({
      settlementBatchId: `settlement-${idempotencyKey}`,
      createdOrders: [],
      groupResults: [],
      failedGroups: [],
    }));

    const payload = {
      draftId: "11111111-1111-4111-8111-111111111111",
      requestedWalletFen: 0,
      selectedGroupIds: ["22222222-2222-4222-8222-222222222222"],
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    };

    const first = await submitBulkDraftAction(payload);
    const second = await submitBulkDraftAction(payload);

    expect(first).toMatchObject({
      ok: true,
      result: { settlementBatchId: "settlement-11111111-1111-4111-8111-111111111111" },
    });
    expect(second).toMatchObject({
      ok: true,
      result: { settlementBatchId: "settlement-11111111-1111-4111-8111-111111111111" },
    });
    expect(serviceMocks.submitBulkDraft).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(serviceMocks.submitBulkDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("does not expose an unexpected persistence error to the customer", async () => {
    serviceMocks.submitBulkDraft.mockRejectedValue(
      new Error(
        'duplicate key value violates unique constraint "wallet_transactions_pkey"',
      ),
    );

    const result = await submitBulkDraftAction({
      draftId: "11111111-1111-4111-8111-111111111111",
      requestedWalletFen: 0,
      selectedGroupIds: ["22222222-2222-4222-8222-222222222222"],
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });

    expect(result).toEqual({
      message: "批量拿货提交失败，请稍后重试。",
      ok: false,
    });
  });
});
