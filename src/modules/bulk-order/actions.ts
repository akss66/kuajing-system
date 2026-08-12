"use server";

import { z } from "zod";

import { requireCustomer } from "@/modules/identity/guards";
import {
  TEMU_MAX_FILE_BYTES,
  TEMU_XLSX_MIME_TYPE,
} from "@/modules/order-import/temu-parser";

import {
  addStoreGroup,
  createBulkDraft,
  getBulkDraft,
  removeGroupFile,
  uploadGroupFiles,
} from "./draft-service";

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

export async function createBulkDraftAction() {
  const principal = await requireCustomer();
  return createBulkDraft({
    actorUserId: principal.userId,
    customerId: principal.customerId,
  });
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
