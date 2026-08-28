"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireCustomer } from "@/modules/identity/guards";

import {
  generateAiSkuMatchSuggestions,
  rejectAiSkuMatchSuggestion,
} from "./service";

export type AiSkuMatchActionState = {
  status: "idle" | "error" | "success";
  message?: string;
};

const batchSchema = z.object({ batchId: z.string().uuid() });
const rejectionSchema = batchSchema.extend({
  suggestionId: z.string().uuid(),
});

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function generationErrorMessage(error: unknown) {
  const code = errorCode(error);
  if (code === "RATE_LIMITED") {
    return "智能推荐操作过于频繁，请十分钟后再试。";
  }
  if (code === "PROVIDER_FAILED" || code === "UNAVAILABLE") {
    return "智能推荐暂时不可用，您仍可继续手工填写 SKU。";
  }
  if (code === "ACCESS_DISABLED") {
    return "该账号尚未开放智能 SKU 推荐。";
  }
  if (code === "NO_ELIGIBLE_ROWS") {
    return "当前没有可智能推荐的待匹配行。";
  }
  if (code === "PREVIEW_EXPIRED" || code === "PREVIEW_NOT_FOUND") {
    return "导入预览已过期或不存在，请重新上传订单。";
  }
  return "智能推荐未完成，您仍可继续手工填写 SKU。";
}

function rejectionErrorMessage(error: unknown) {
  const code = errorCode(error);
  if (code === "SUGGESTION_STALE" || code === "SUGGESTION_NOT_FOUND") {
    return "该智能建议已失效，请刷新后继续手工填写 SKU。";
  }
  return "反馈未能保存，请刷新后重试。";
}

export async function generateAiSkuMatchSuggestionsAction(
  _previousState: AiSkuMatchActionState,
  formData: FormData,
): Promise<AiSkuMatchActionState> {
  const principal = await requireCustomer();
  const parsed = batchSchema.safeParse({ batchId: formData.get("batchId") });
  if (!parsed.success) {
    return { message: "导入预览参数无效。", status: "error" };
  }

  try {
    const result = await generateAiSkuMatchSuggestions({
      actorUserId: principal.userId,
      batchId: parsed.data.batchId,
      customerId: principal.customerId,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    if (result.status === "CACHED") {
      return {
        message: "已有仍然有效的智能建议，无需重复生成。",
        status: "success",
      };
    }
    return {
      message:
        result.suggestionCount > 0
          ? `已生成 ${result.suggestionCount} 个智能建议，请逐行确认后保存。`
          : "本次未找到可靠候选，您仍可继续手工填写 SKU。",
      status: "success",
    };
  } catch (error) {
    return { message: generationErrorMessage(error), status: "error" };
  }
}

export async function rejectAiSkuMatchSuggestionAction(
  _previousState: AiSkuMatchActionState,
  formData: FormData,
): Promise<AiSkuMatchActionState> {
  const principal = await requireCustomer();
  const parsed = rejectionSchema.safeParse({
    batchId: formData.get("batchId"),
    suggestionId: formData.get("suggestionId"),
  });
  if (!parsed.success) {
    return { message: "智能建议参数无效。", status: "error" };
  }

  try {
    await rejectAiSkuMatchSuggestion({
      actorUserId: principal.userId,
      batchId: parsed.data.batchId,
      customerId: principal.customerId,
      suggestionId: parsed.data.suggestionId,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    return {
      message: "已记录反馈，您可以继续手工填写 SKU。",
      status: "success",
    };
  } catch (error) {
    return { message: rejectionErrorMessage(error), status: "error" };
  }
}
