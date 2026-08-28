import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const guardMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
  generateAiSkuMatchSuggestions: vi.fn(),
  rejectAiSkuMatchSuggestion: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/ai-sku-matching/service", () => ({
  AiSkuMatchError: class AiSkuMatchError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  generateAiSkuMatchSuggestions: serviceMocks.generateAiSkuMatchSuggestions,
  rejectAiSkuMatchSuggestion: serviceMocks.rejectAiSkuMatchSuggestion,
}));

import {
  generateAiSkuMatchSuggestionsAction,
  rejectAiSkuMatchSuggestionAction,
} from "@/modules/ai-sku-matching/actions";

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const batchId = "43f18cb3-9dc2-4651-94d3-e1ed67d89b15";
const suggestionId = "ab611461-ec62-46ea-81a1-f60687bbfde7";

describe("AI SKU matching customer actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireCustomer.mockReset();
    serviceMocks.generateAiSkuMatchSuggestions.mockReset();
    serviceMocks.rejectAiSkuMatchSuggestion.mockReset();
    guardMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-from-session",
      userId: "user-from-session",
    });
    serviceMocks.generateAiSkuMatchSuggestions.mockResolvedValue({
      status: "SUCCEEDED",
      suggestionCount: 3,
    });
    serviceMocks.rejectAiSkuMatchSuggestion.mockResolvedValue(undefined);
  });

  it("uses session identity and revalidates after generating suggestions", async () => {
    const data = form({ batchId, customerId: "attacker-customer" });

    const result = await generateAiSkuMatchSuggestionsAction(
      { status: "idle" },
      data,
    );

    expect(serviceMocks.generateAiSkuMatchSuggestions).toHaveBeenCalledWith({
      actorUserId: "user-from-session",
      batchId,
      customerId: "customer-from-session",
    });
    expect(result).toEqual({
      message: "已生成 3 个智能建议，请逐行确认后保存。",
      status: "success",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      `/portal/imports/${batchId}`,
    );
  });

  it("does not call the service for an invalid batch id", async () => {
    const result = await generateAiSkuMatchSuggestionsAction(
      { status: "idle" },
      form({ batchId: "invalid" }),
    );

    expect(result).toEqual({ message: "导入预览参数无效。", status: "error" });
    expect(serviceMocks.generateAiSkuMatchSuggestions).not.toHaveBeenCalled();
  });

  it.each([
    ["RATE_LIMITED", "智能推荐操作过于频繁，请十分钟后再试。"],
    ["PROVIDER_FAILED", "智能推荐暂时不可用，您仍可继续手工填写 SKU。"],
    ["ACCESS_DISABLED", "该账号尚未开放智能 SKU 推荐。"],
  ])("maps %s to a safe customer message", async (code, message) => {
    serviceMocks.generateAiSkuMatchSuggestions.mockRejectedValueOnce({ code });

    const result = await generateAiSkuMatchSuggestionsAction(
      { status: "idle" },
      form({ batchId }),
    );

    expect(result).toEqual({ message, status: "error" });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects only a validated suggestion owned by the session customer", async () => {
    const data = form({
      batchId,
      customerId: "attacker-customer",
      suggestionId,
    });

    const result = await rejectAiSkuMatchSuggestionAction(
      { status: "idle" },
      data,
    );

    expect(serviceMocks.rejectAiSkuMatchSuggestion).toHaveBeenCalledWith({
      actorUserId: "user-from-session",
      batchId,
      customerId: "customer-from-session",
      suggestionId,
    });
    expect(result).toEqual({
      message: "已记录反馈，您可以继续手工填写 SKU。",
      status: "success",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      `/portal/imports/${batchId}`,
    );
  });

  it("requires valid UUIDs before rejecting a suggestion", async () => {
    const result = await rejectAiSkuMatchSuggestionAction(
      { status: "idle" },
      form({ batchId, suggestionId: "invalid" }),
    );

    expect(result.status).toBe("error");
    expect(serviceMocks.rejectAiSkuMatchSuggestion).not.toHaveBeenCalled();
  });

  it("does not swallow authentication failures", async () => {
    const accessError = new Error("UNAUTHENTICATED");
    guardMocks.requireCustomer.mockRejectedValueOnce(accessError);

    await expect(
      generateAiSkuMatchSuggestionsAction(
        { status: "idle" },
        form({ batchId }),
      ),
    ).rejects.toBe(accessError);
  });
});
