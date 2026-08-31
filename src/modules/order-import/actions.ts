"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";

import { AccessError, requireCustomer } from "@/modules/identity/guards";

import {
  addCustomerImportRowFulfillmentItem,
  ImportPreviewError,
  createTemuImportPreview,
  removeCustomerImportRowFulfillmentItem,
  updateCustomerImportRowFulfillmentItem,
  updateCustomerImportRowOverride,
} from "./service";
import { TemuWorkbookError } from "./temu-parser";
import type { TemuUploadActionState } from "./action-state";

const storeSchema = z.string().uuid("请选择有效店铺");

export type ImportRowOverrideActionState = {
  status: "idle" | "error" | "success";
  message?: string;
};

const rowOverrideSchema = z.object({
  aiSuggestionId: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length > 0
        ? value
        : undefined,
    z.string().uuid().optional(),
  ),
  batchId: z.string().uuid(),
  effectiveQuantity: z.coerce.number().int().min(1).max(1_000_000),
  expectedRevision: z.coerce.number().int().min(0),
  rowId: z.string().uuid(),
  skuCode: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length > 0
        ? value
        : undefined,
    z.string().trim().min(1).max(160).optional(),
  ),
});

const fulfillmentItemSchema = z.object({
  batchId: z.string().uuid(),
  effectiveQuantity: z.coerce.number().int().min(1).max(1_000_000),
  expectedRevision: z.coerce.number().int().min(0),
  rowId: z.string().uuid(),
  skuCode: z.string().trim().min(1).max(160),
});

const existingFulfillmentItemSchema = fulfillmentItemSchema.extend({
  itemId: z.string().uuid(),
});

const removeFulfillmentItemSchema = fulfillmentItemSchema
  .pick({ batchId: true, expectedRevision: true, rowId: true })
  .extend({ itemId: z.string().uuid() });

function rowOverrideErrorMessage(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null;
  if (code === "IMPORT_ROW_CONFLICT") {
    return "该行已被其他操作更新，请刷新后重试。";
  }
  if (code === "SKU_NOT_AVAILABLE") {
    return "SKU 不存在、已下架或不可售，请重新选择。";
  }
  if (code === "INSUFFICIENT_STOCK") {
    return "对应 SKU 库存不足，请更换 SKU 或减少数量。";
  }
  if (code === "AI_SUGGESTION_INVALID") {
    return "该智能建议已失效，请重新获取或手工填写。";
  }
  if (error instanceof ImportPreviewError) return error.message;
  return "保存失败，请稍后重试。";
}

export async function updateCustomerImportRowAction(
  _previousState: ImportRowOverrideActionState,
  formData: FormData,
): Promise<ImportRowOverrideActionState> {
  const principal = await requireCustomer();
  const parsed = rowOverrideSchema.safeParse({
    aiSuggestionId: formData.get("aiSuggestionId"),
    batchId: formData.get("batchId"),
    effectiveQuantity: formData.get("effectiveQuantity"),
    expectedRevision: formData.get("expectedRevision"),
    rowId: formData.get("rowId"),
    skuCode: formData.get("skuCode"),
  });
  if (!parsed.success) {
    return { status: "error", message: "请填写有效的 SKU 和实际发货数量。" };
  }

  try {
    await updateCustomerImportRowOverride({
      actorUserId: principal.userId,
      aiSuggestionId: parsed.data.aiSuggestionId,
      batchId: parsed.data.batchId,
      customerId: principal.customerId,
      effectiveQuantity: parsed.data.effectiveQuantity,
      expectedRevision: parsed.data.expectedRevision,
      rowId: parsed.data.rowId,
      skuCode: parsed.data.skuCode,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    return { status: "success", message: "已保存并重新校验。" };
  } catch (error) {
    return { status: "error", message: rowOverrideErrorMessage(error) };
  }
}

function fulfillmentItemValues(formData: FormData) {
  return {
    batchId: formData.get("batchId"),
    effectiveQuantity: formData.get("effectiveQuantity"),
    expectedRevision: formData.get("expectedRevision"),
    itemId: formData.get("itemId"),
    rowId: formData.get("rowId"),
    skuCode: formData.get("skuCode"),
  };
}

export async function addCustomerImportRowFulfillmentItemAction(
  _previousState: ImportRowOverrideActionState,
  formData: FormData,
): Promise<ImportRowOverrideActionState> {
  const principal = await requireCustomer();
  const parsed = fulfillmentItemSchema.safeParse(fulfillmentItemValues(formData));
  if (!parsed.success) {
    return { status: "error", message: "请填写有效且非空的 SKU 和发货数量。" };
  }
  try {
    await addCustomerImportRowFulfillmentItem({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      ...parsed.data,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    return { status: "success", message: "已添加货品并重新校验。" };
  } catch (error) {
    return { status: "error", message: rowOverrideErrorMessage(error) };
  }
}

export async function updateCustomerImportRowFulfillmentItemAction(
  _previousState: ImportRowOverrideActionState,
  formData: FormData,
): Promise<ImportRowOverrideActionState> {
  const principal = await requireCustomer();
  const parsed = existingFulfillmentItemSchema.safeParse(
    fulfillmentItemValues(formData),
  );
  if (!parsed.success) {
    return { status: "error", message: "请填写有效且非空的 SKU 和发货数量。" };
  }
  try {
    await updateCustomerImportRowFulfillmentItem({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      ...parsed.data,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    return { status: "success", message: "已更新货品并重新校验。" };
  } catch (error) {
    return { status: "error", message: rowOverrideErrorMessage(error) };
  }
}

export async function removeCustomerImportRowFulfillmentItemAction(
  _previousState: ImportRowOverrideActionState,
  formData: FormData,
): Promise<ImportRowOverrideActionState> {
  const principal = await requireCustomer();
  const parsed = removeFulfillmentItemSchema.safeParse(
    fulfillmentItemValues(formData),
  );
  if (!parsed.success) {
    return { status: "error", message: "无法识别要删除的货品，请刷新后重试。" };
  }
  try {
    await removeCustomerImportRowFulfillmentItem({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      ...parsed.data,
    });
    revalidatePath(`/portal/imports/${parsed.data.batchId}`);
    return { status: "success", message: "已删除货品并重新校验。" };
  } catch (error) {
    return { status: "error", message: rowOverrideErrorMessage(error) };
  }
}

export async function uploadTemuOrdersAction(
  _previousState: TemuUploadActionState,
  formData: FormData,
): Promise<TemuUploadActionState> {
  const principal = await requireCustomer();
  const parsedStoreId = storeSchema.safeParse(formData.get("storeId"));
  if (!parsedStoreId.success) {
    return { status: "error", message: "请选择要导入订单的店铺。" };
  }

  const uploaded = formData.get("temuWorkbook");
  if (!(uploaded instanceof File) || uploaded.size === 0) {
    return { status: "error", message: "请选择 TEMU 导出的 Excel 文件。" };
  }

  try {
    const preview = await createTemuImportPreview({
      actorUserId: principal.userId,
      buffer: new Uint8Array(await uploaded.arrayBuffer()),
      customerId: principal.customerId,
      fileName: uploaded.name,
      mimeType: uploaded.type,
      storeId: parsedStoreId.data,
    });

    return {
      batchId: preview.batchId,
      message: "订单解析完成，正在打开预览。",
      status: "success",
    };
  } catch (error) {
    if (error instanceof AccessError) {
      return { status: "error", message: "无权使用该店铺，请重新选择。" };
    }
    if (
      error instanceof TemuWorkbookError ||
      error instanceof ImportPreviewError
    ) {
      return { status: "error", message: error.message };
    }

    return {
      status: "error",
      message: "订单文件处理失败，请稍后重试或联系管理员。",
    };
  }
}
