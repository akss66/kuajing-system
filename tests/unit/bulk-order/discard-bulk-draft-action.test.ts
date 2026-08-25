import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const draftServiceMocks = vi.hoisted(() => {
  class BulkDraftError extends Error {}

  return {
    addStoreGroup: vi.fn(),
    BulkDraftError,
    createBulkDraft: vi.fn(),
    discardBulkDraft: vi.fn(),
    getBulkDraft: vi.fn(),
    removeGroupFile: vi.fn(),
    uploadGroupFiles: vi.fn(),
  };
});
const submissionServiceMocks = vi.hoisted(() => ({
  BulkSubmissionError: class BulkSubmissionError extends Error {},
  submitBulkDraft: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/bulk-order/draft-service", () => draftServiceMocks);
vi.mock("@/modules/bulk-order/submission-service", () => submissionServiceMocks);

import { discardBulkDraftAction } from "@/modules/bulk-order/actions";

describe("discardBulkDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
  });

  it("rejects invalid input before touching upload data", async () => {
    const formData = new FormData();
    formData.set("draftId", "not-a-uuid");

    await expect(
      discardBulkDraftAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message: "上传记录参数无效，请刷新页面后重试。",
      status: "error",
    });
    expect(draftServiceMocks.discardBulkDraft).not.toHaveBeenCalled();
  });

  it("scopes deletion to the authenticated customer and refreshes the list", async () => {
    const formData = new FormData();
    formData.set("draftId", "11111111-1111-4111-8111-111111111111");

    await expect(
      discardBulkDraftAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message: "未提交的上传内容已删除。",
      status: "success",
    });
    expect(draftServiceMocks.discardBulkDraft).toHaveBeenCalledWith({
      actorUserId: "user-1",
      customerId: "customer-1",
      draftId: "11111111-1111-4111-8111-111111111111",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/portal/bulk-orders",
    );
  });
});
