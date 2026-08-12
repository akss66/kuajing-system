"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireSuperAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  createAdminAccount,
  resetManagedAccountPassword,
  setManagedAccountStatus,
  updateManagedAccount,
} from "./service";

function validationState(error: z.ZodError): ActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

function revalidateAccountManagement() {
  revalidatePath("/admin");
  revalidatePath("/admin/accounts");
}

const createAdminSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z.email(),
  password: z.string().min(12),
  reason: z.string().trim().min(1).max(500),
});

export async function createAdminAccountAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireSuperAdmin();
  const parsed = createAdminSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return validationState(parsed.error);
  await createAdminAccount({ actor, ...parsed.data });
  revalidateAccountManagement();
  return { message: "普通管理员账号已创建。", status: "success" };
}

const updateSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z.email(),
  reason: z.string().trim().min(1).max(500),
  userId: z.string().min(1),
});

export async function updateManagedAccountAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireSuperAdmin();
  const parsed = updateSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    reason: formData.get("reason"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  await updateManagedAccount({ actor, ...parsed.data });
  revalidateAccountManagement();
  return { message: "账号资料已更新。", status: "success" };
}

const passwordSchema = z.object({
  newPassword: z.string().min(12),
  reason: z.string().trim().min(1).max(500),
  userId: z.string().min(1),
});

export async function resetManagedAccountPasswordAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireSuperAdmin();
  const parsed = passwordSchema.safeParse({
    newPassword: formData.get("newPassword"),
    reason: formData.get("reason"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  await resetManagedAccountPassword({ actor, ...parsed.data });
  return { message: "登录密码已重置。", status: "success" };
}

const statusSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["ACTIVE", "DISABLED"]),
  userId: z.string().min(1),
});

export async function setManagedAccountStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireSuperAdmin();
  const parsed = statusSchema.safeParse({
    reason: formData.get("reason"),
    status: formData.get("status"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  await setManagedAccountStatus({ actor, ...parsed.data });
  revalidateAccountManagement();
  return {
    message: parsed.data.status === "DISABLED" ? "账号已停用。" : "账号已恢复。",
    status: "success",
  };
}
