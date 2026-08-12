"use server";

import { z } from "zod";

import { AccessError, requireCustomer } from "@/modules/identity/guards";

import { ImportPreviewError, createTemuImportPreview } from "./service";
import { TemuWorkbookError } from "./temu-parser";
import type { TemuUploadActionState } from "./action-state";

const storeSchema = z.string().uuid("请选择有效店铺");

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
