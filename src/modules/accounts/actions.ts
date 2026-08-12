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

type ErrorLike = {
  cause?: unknown;
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  message?: unknown;
};

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

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && typeof current === "object" && depth < 6) {
    const typed = current as ErrorLike;
    chain.push(typed);
    current = typed.cause;
    depth += 1;
  }

  return chain;
}

function errorCode(error: unknown) {
  return errorChain(error).find((entry) => typeof entry.code === "string")?.code as
    | string
    | undefined;
}

function isUniqueConstraint(error: unknown, constraints: string[]) {
  return errorChain(error).some((entry) => {
    const constraint =
      typeof entry.constraint_name === "string"
        ? entry.constraint_name
        : typeof entry.constraint === "string"
          ? entry.constraint
          : undefined;
    const mentionsUnique =
      typeof entry.message === "string" &&
      entry.message.toLowerCase().includes("unique constraint");

    if (constraint) {
      return constraints.includes(constraint);
    }

    return entry.code === "23505" || mentionsUnique;
  });
}

function governanceErrorState(error: unknown): ActionState | null {
  if (
    isUniqueConstraint(error, [
      "admin_users_login_identifier_unique",
      "auth_users_email_unique",
      "customer_users_login_identifier_unique",
    ])
  ) {
    return {
      message: "登录邮箱已存在，请更换后重试。",
      status: "error",
    };
  }

  switch (errorCode(error)) {
    case "ACCOUNT_NOT_FOUND":
      return {
        message: "账号记录不存在，页面可能已过期，请刷新后重试。",
        status: "error",
      };
    case "FORBIDDEN_SUPER_ADMIN":
      return {
        message: "只有超级管理员可以执行账号治理操作。",
        status: "error",
      };
    case "INVALID_PASSWORD":
      return {
        message: "新密码至少需要 12 位，请重新输入。",
        status: "error",
      };
    case "INVALID_REASON":
      return {
        message: "请填写本次操作原因后再提交。",
        status: "error",
      };
    case "PROHIBITED_SUPER_ADMIN_CREATION":
      return {
        message: "这里只允许创建或维护普通管理员账号。",
        status: "error",
      };
    case "SUPER_ADMIN_IMMUTABLE":
      return {
        message: "受保护的超级管理员不支持此操作。",
        status: "error",
      };
    default:
      return null;
  }
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

  try {
    await createAdminAccount({
      actor,
      ...parsed.data,
      email: parsed.data.email.trim().toLowerCase(),
    });
  } catch (error) {
    const state = governanceErrorState(error);
    if (state) return state;
    throw error;
  }

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

  try {
    await updateManagedAccount({
      actor,
      ...parsed.data,
      email: parsed.data.email.trim().toLowerCase(),
    });
  } catch (error) {
    const state = governanceErrorState(error);
    if (state) return state;
    throw error;
  }

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

  try {
    await resetManagedAccountPassword({ actor, ...parsed.data });
  } catch (error) {
    const state = governanceErrorState(error);
    if (state) return state;
    throw error;
  }

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

  try {
    await setManagedAccountStatus({ actor, ...parsed.data });
  } catch (error) {
    const state = governanceErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateAccountManagement();
  return {
    message: parsed.data.status === "DISABLED" ? "账号已停用。" : "账号已恢复。",
    status: "success",
  };
}
