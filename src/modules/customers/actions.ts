"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin, requireSuperAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  createStore,
  provisionCustomerWithStore,
  setCustomerStatus,
  setStoreStatus,
  updateCustomer,
  updateStore,
} from "./service";

type ErrorLike = {
  cause?: unknown;
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
};

const CUSTOMER_DUPLICATE_CONSTRAINTS = new Set([
  "auth_users_email_unique",
  "customer_users_login_identifier_unique",
  "customers_code_unique",
  "stores_customer_name_unique",
]);

const CUSTOMER_CODE_DUPLICATE_CONSTRAINTS = new Set(["customers_code_unique"]);
const STORE_NAME_DUPLICATE_CONSTRAINTS = new Set(["stores_customer_name_unique"]);

const createCustomerSchema = z.object({
  code: z
    .string({ error: "请输入客户编号。" })
    .trim()
    .min(2, "客户编号至少需要 2 个字符。")
    .max(40, "客户编号不能超过 40 个字符。"),
  customerName: z
    .string({ error: "请输入客户名称。" })
    .trim()
    .min(2, "客户名称至少需要 2 个字符。")
    .max(160, "客户名称不能超过 160 个字符。"),
  email: z.email({ error: "请输入有效的登录邮箱。" }),
  password: z
    .string({ error: "请输入初始密码。" })
    .min(12, "初始密码至少需要 12 个字符。"),
  reason: z
    .string({ error: "请输入创建原因。" })
    .trim()
    .min(1, "请输入创建原因。")
    .max(500, "创建原因不能超过 500 个字符。"),
  storeName: z
    .string({ error: "请输入店铺名称。" })
    .trim()
    .min(2, "店铺名称至少需要 2 个字符。")
    .max(160, "店铺名称不能超过 160 个字符。"),
});

const updateCustomerSchema = z.object({
  code: z.string().trim().min(2).max(40),
  contactName: z.string().trim().max(120).optional(),
  contactWechat: z.string().trim().max(120).optional(),
  customerId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  reason: z.string().trim().min(1).max(500),
});

const createStoreSchema = z.object({
  customerId: z.string().uuid(),
  externalStoreCode: z.string().trim().max(120).optional(),
  name: z.string().trim().min(2).max(160),
  platform: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().min(1).max(500),
});

const updateStoreSchema = z.object({
  externalStoreCode: z.string().trim().max(120).optional(),
  name: z.string().trim().min(2).max(160),
  platform: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().min(1).max(500),
  storeId: z.string().uuid(),
});

const customerStatusSchema = z.object({
  customerId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

const storeStatusSchema = z.object({
  customerId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["ACTIVE", "DISABLED"]),
  storeId: z.string().uuid(),
});

function validationState(error: z.ZodError): ActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

function revalidateCustomerManagement(customerId: string) {
  revalidatePath("/admin/customers");
  revalidatePath(`/admin/customers/${customerId}`);
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

function hasAllowedConstraint(error: unknown, constraints: Set<string>) {
  return errorChain(error).some((entry) => {
    const constraint =
      typeof entry.constraint_name === "string"
        ? entry.constraint_name
        : typeof entry.constraint === "string"
          ? entry.constraint
          : undefined;

    return constraint !== undefined && constraints.has(constraint);
  });
}

function customerErrorState(error: unknown): ActionState | null {
  switch (errorCode(error)) {
    case "CUSTOMER_NOT_FOUND":
      return {
        message: "客户记录不存在，页面可能已过期，请刷新后重试。",
        status: "error",
      };
    case "STORE_NOT_FOUND":
      return {
        message: "店铺记录不存在，页面可能已过期，请刷新后重试。",
        status: "error",
      };
    case "INVALID_REASON":
      return {
        message: "请填写本次操作原因后再提交。",
        status: "error",
      };
    default:
      return null;
  }
}

export async function createCustomerWithStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = createCustomerSchema.safeParse({
    code: formData.get("code"),
    customerName: formData.get("customerName"),
    email: formData.get("email"),
    password: formData.get("password"),
    reason: formData.get("reason"),
    storeName: formData.get("storeName"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await provisionCustomerWithStore({
      actor: principal,
      ...parsed.data,
      email: parsed.data.email.trim().toLowerCase(),
    });
  } catch (error) {
    if (hasAllowedConstraint(error, CUSTOMER_DUPLICATE_CONSTRAINTS)) {
      return {
        message: "客户编号、店铺名称或登录邮箱已存在，请核对后重试。",
        status: "error",
      };
    }

    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  return { message: "客户与首家店铺已创建。", status: "success" };
}

export async function updateCustomerAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = updateCustomerSchema.safeParse({
    code: formData.get("code"),
    contactName: formData.get("contactName") || undefined,
    contactWechat: formData.get("contactWechat") || undefined,
    customerId: formData.get("customerId"),
    name: formData.get("name"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await updateCustomer({ actor, ...parsed.data });
  } catch (error) {
    if (hasAllowedConstraint(error, CUSTOMER_CODE_DUPLICATE_CONSTRAINTS)) {
      return {
        message: "客户编号已存在，请更换后重试。",
        status: "error",
      };
    }

    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateCustomerManagement(parsed.data.customerId);
  return { message: "客户资料已更新。", status: "success" };
}

export async function createStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = createStoreSchema.safeParse({
    customerId: formData.get("customerId"),
    externalStoreCode: formData.get("externalStoreCode") || undefined,
    name: formData.get("name"),
    platform: formData.get("platform") || undefined,
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await createStore({ actor, ...parsed.data });
  } catch (error) {
    if (hasAllowedConstraint(error, STORE_NAME_DUPLICATE_CONSTRAINTS)) {
      return {
        message: "该客户下已存在同名店铺，请调整后重试。",
        status: "error",
      };
    }

    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateCustomerManagement(parsed.data.customerId);
  return { message: "店铺已新增。", status: "success" };
}

export async function updateStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const customerId = String(formData.get("customerId") ?? "");
  const parsed = updateStoreSchema.safeParse({
    externalStoreCode: formData.get("externalStoreCode") || undefined,
    name: formData.get("name"),
    platform: formData.get("platform") || undefined,
    reason: formData.get("reason"),
    storeId: formData.get("storeId"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await updateStore({ actor, ...parsed.data });
  } catch (error) {
    if (hasAllowedConstraint(error, STORE_NAME_DUPLICATE_CONSTRAINTS)) {
      return {
        message: "该客户下已存在同名店铺，请调整后重试。",
        status: "error",
      };
    }

    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateCustomerManagement(customerId);
  return { message: "店铺资料已更新。", status: "success" };
}

export async function setCustomerStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireSuperAdmin();
  const parsed = customerStatusSchema.safeParse({
    customerId: formData.get("customerId"),
    reason: formData.get("reason"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await setCustomerStatus({ actor, ...parsed.data });
  } catch (error) {
    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateCustomerManagement(parsed.data.customerId);
  return {
    message: parsed.data.status === "DISABLED" ? "客户已停用。" : "客户已恢复。",
    status: "success",
  };
}

export async function setStoreStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = storeStatusSchema.safeParse({
    customerId: formData.get("customerId"),
    reason: formData.get("reason"),
    status: formData.get("status"),
    storeId: formData.get("storeId"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await setStoreStatus({
      actor,
      reason: parsed.data.reason,
      status: parsed.data.status,
      storeId: parsed.data.storeId,
    });
  } catch (error) {
    const state = customerErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateCustomerManagement(parsed.data.customerId);
  return {
    message: parsed.data.status === "DISABLED" ? "店铺已停用。" : "店铺已恢复。",
    status: "success",
  };
}
