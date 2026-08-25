"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireCustomer } from "@/modules/identity/guards";
import {
  TEMU_MAX_FILE_BYTES,
  TEMU_XLSX_MIME_TYPE,
} from "@/modules/order-import/temu-parser";

import {
  addStoreGroup,
  BulkDraftError,
  createBulkDraft,
  discardBulkDraft,
  getBulkDraft,
  removeGroupFile,
  uploadGroupFiles,
} from "./draft-service";
import {
  BulkSubmissionError,
  submitBulkDraft,
  type BulkSubmissionResult,
} from "./submission-service";
import type { ActionState } from "@/shared/action-state";

const idSchema = z.string().uuid();
const groupInputSchema = z.object({
  draftId: idSchema,
  storeId: idSchema,
});
const uploadedFileSchema = z
  .instanceof(File)
  .refine((file) => file.size > 0 && file.size <= TEMU_MAX_FILE_BYTES)
  .refine(
    (file) =>
      file.name.toLowerCase().endsWith(".xlsx") &&
      file.type === TEMU_XLSX_MIME_TYPE,
  );
const submitDraftSchema = z.object({
  draftId: idSchema,
  idempotencyKey: z.string().uuid().max(64),
  requestedWalletFen: z.number().int().min(0).max(2_147_483_647),
  selectedGroupIds: z.array(idSchema).min(1).max(20),
});

export type SubmitBulkDraftActionResult =
  | { ok: true; result: BulkSubmissionResult }
  | { message: string; ok: false };

export async function createBulkDraftAction() {
  const principal = await requireCustomer();
  return createBulkDraft({
    actorUserId: principal.userId,
    customerId: principal.customerId,
  });
}

export async function discardBulkDraftAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireCustomer();
  const parsed = idSchema.safeParse(formData.get("draftId"));
  if (!parsed.success) {
    return { message: "上传记录参数无效，请刷新页面后重试。", status: "error" };
  }

  try {
    await discardBulkDraft({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      draftId: parsed.data,
    });
  } catch (error) {
    return error instanceof BulkDraftError
      ? { message: error.message, status: "error" }
      : { message: "暂时无法放弃本次上传，请稍后重试。", status: "error" };
  }

  revalidatePath("/portal/bulk-orders");
  return { message: "未提交的上传内容已删除。", status: "success" };
}

export async function addStoreGroupAction(input: unknown) {
  const principal = await requireCustomer();
  const parsed = groupInputSchema.parse(input);
  return addStoreGroup({
    customerId: principal.customerId,
    draftId: parsed.draftId,
    storeId: parsed.storeId,
  });
}

export async function uploadGroupFilesAction(formData: FormData) {
  const principal = await requireCustomer();
  const groupId = idSchema.parse(formData.get("groupId"));
  const files = z
    .array(uploadedFileSchema)
    .min(1)
    .max(10)
    .parse(formData.getAll("files"));

  return uploadGroupFiles({
    actorUserId: principal.userId,
    customerId: principal.customerId,
    files: await Promise.all(
      files.map(async (file) => ({
        buffer: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name,
        mimeType: file.type,
      })),
    ),
    groupId,
  });
}

export async function getBulkDraftAction(draftId: unknown) {
  const principal = await requireCustomer();
  return getBulkDraft(principal.customerId, idSchema.parse(draftId));
}

export async function removeGroupFileAction(batchId: unknown) {
  const principal = await requireCustomer();
  return removeGroupFile({
    batchId: idSchema.parse(batchId),
    customerId: principal.customerId,
  });
}

export async function submitBulkDraftAction(
  input: unknown,
): Promise<SubmitBulkDraftActionResult> {
  const principal = await requireCustomer();
  const parsed = submitDraftSchema.safeParse(input);
  if (!parsed.success) {
    return {
      message: "提交参数不完整，请刷新页面后重试。",
      ok: false,
    };
  }

  try {
    const result = await submitBulkDraft({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      draftId: parsed.data.draftId,
      idempotencyKey: parsed.data.idempotencyKey,
      requestedWalletFen: parsed.data.requestedWalletFen,
      selectedGroupIds: parsed.data.selectedGroupIds,
    });
    revalidatePath(`/portal/bulk-orders/${parsed.data.draftId}`);
    revalidatePath("/portal/orders");
    revalidatePath("/portal/wallet");
    if (result.settlementBatchId) {
      revalidatePath(`/portal/settlements/${result.settlementBatchId}`);
    }
    return { ok: true, result };
  } catch (error) {
    if (error instanceof BulkSubmissionError) {
      return { message: error.message, ok: false };
    }
    return { message: "批量拿货提交失败，请稍后重试。", ok: false };
  }
}
