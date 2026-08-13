"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireSuperAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  authorizeJifengConnection,
  disconnectJifengConnection,
  discoverJifengResources,
  runStoredJifengDiagnostic,
  selectJifengResources,
  setJifengFulfillmentEnabled,
} from "./service";

const INTEGRATIONS_PATH = "/admin/system/integrations";

export type JifengResourceOptions = {
  logistics: Array<{ id: number; name: string }>;
  warehouses: Array<{ code: string; name: string }>;
};

export type JifengActionState = ActionState & {
  resources?: JifengResourceOptions;
};

const authorizationSchema = z.object({
  email: z
    .string({ error: "请输入授权邮箱。" })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "请输入有效的授权邮箱。" })),
  oneTimeToken: z
    .string({ error: "请输入一次性令牌。" })
    .trim()
    .min(16, "一次性令牌至少需要 16 个字符。")
    .max(512, "一次性令牌不能超过 512 个字符。"),
});

const resourceSelectionSchema = z.object({
  logisticsId: z.coerce
    .number({ error: "请选择物流渠道。" })
    .int("物流渠道标识无效。")
    .positive("请选择物流渠道。")
    .max(2_147_483_647, "物流渠道标识无效。"),
  warehouseCode: z
    .string({ error: "请选择仓库。" })
    .trim()
    .min(1, "请选择仓库。")
    .max(128, "仓库标识无效。"),
});

const reasonSchema = z
  .string({ error: "请填写操作原因。" })
  .trim()
  .min(2, "操作原因至少需要 2 个字符。")
  .max(500, "操作原因不能超过 500 个字符。");

const fulfillmentSchema = z.object({
  enabled: z.enum(["true", "false"], {
    error: "履约状态无效，请刷新页面后重试。",
  }),
  reason: reasonSchema,
});

const disconnectSchema = z.object({ reason: reasonSchema });

function validationState(error: z.ZodError): JifengActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

function revalidateIntegrations() {
  revalidatePath(INTEGRATIONS_PATH);
}

function businessErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function businessErrorState(error: unknown): JifengActionState | null {
  switch (businessErrorCode(error)) {
    case "AUTHORIZATION_FAILED":
      return {
        message: "授权未完成，请获取新的一次性令牌后重试。",
        status: "error",
      };
    case "AUTHORIZATION_RATE_LIMITED":
      return {
        message: "授权尝试过于频繁，请稍后获取新令牌再试。",
        status: "error",
      };
    case "DEVELOPER_CONFIG_INVALID":
      return {
        message: "极风开发者配置尚未就绪，请联系系统维护人员。",
        status: "error",
      };
    case "AUTHORIZATION_REQUIRED":
      return {
        message: "当前连接未完成授权，请重新授权后再试。",
        status: "error",
      };
    case "REFRESH_REQUIRED":
    case "REFRESH_FAILED":
    case "CREDENTIALS_INVALID":
      return {
        message: "授权凭证需要更新，请重新完成极风授权。",
        status: "error",
      };
    case "RESOURCE_INVALID":
    case "RESOURCE_SELECTION_REQUIRED":
      return {
        message: "仓库或物流渠道尚未确认，请重新发现并明确选择。",
        status: "error",
      };
    case "DIAGNOSTIC_REQUIRED":
      return {
        message: "启用前必须先通过最新一次只读诊断。",
        status: "error",
      };
    case "DIAGNOSTIC_STALE":
    case "CONNECTION_CHANGED":
      return {
        message: "连接状态已变化，请刷新页面后重试。",
        status: "error",
      };
    case "FORBIDDEN":
      return {
        message: "只有超级管理员可以管理极风连接。",
        status: "error",
      };
    case "REASON_REQUIRED":
      return {
        message: "请填写本次操作原因后再提交。",
        status: "error",
      };
    default:
      return null;
  }
}

async function runMutation(
  mutation: () => Promise<void>,
  successMessage: string,
): Promise<JifengActionState> {
  try {
    await mutation();
  } catch (error) {
    const state = businessErrorState(error);
    if (state) return state;
    throw error;
  }
  revalidateIntegrations();
  return { message: successMessage, status: "success" };
}

function safeResources(
  discovery: Awaited<ReturnType<typeof discoverJifengResources>>,
): JifengResourceOptions {
  return {
    logistics: discovery.logistics.map(({ id, name }) => ({ id, name })),
    warehouses: discovery.warehouses
      .filter(({ isAuth }) => isAuth !== false)
      .map(({ code, name }) => ({ code, name })),
  };
}

export async function authorizeJifengConnectionAction(
  _previousState: JifengActionState,
  formData: FormData,
): Promise<JifengActionState> {
  const actor = await requireSuperAdmin();
  const parsed = authorizationSchema.safeParse({
    email: formData.get("email"),
    oneTimeToken: formData.get("oneTimeToken"),
  });
  if (!parsed.success) return validationState(parsed.error);

  return runMutation(
    () => authorizeJifengConnection({ actor, ...parsed.data }).then(() => undefined),
    "极风授权已完成。",
  );
}

export async function discoverJifengResourcesAction(
  _previousState: JifengActionState,
  _formData: FormData,
): Promise<JifengActionState> {
  void _previousState;
  void _formData;
  const actor = await requireSuperAdmin();
  try {
    const discovery = await discoverJifengResources({ actor });
    revalidateIntegrations();
    return {
      message: "资源已更新，请明确选择仓库和物流渠道。",
      resources: safeResources(discovery),
      status: "success",
    };
  } catch (error) {
    const state = businessErrorState(error);
    if (state) return state;
    throw error;
  }
}

export async function selectJifengResourcesAction(
  _previousState: JifengActionState,
  formData: FormData,
): Promise<JifengActionState> {
  const actor = await requireSuperAdmin();
  const parsed = resourceSelectionSchema.safeParse({
    logisticsId: formData.get("logisticsId"),
    warehouseCode: formData.get("warehouseCode"),
  });
  if (!parsed.success) return validationState(parsed.error);

  try {
    const discovery = await discoverJifengResources({ actor });
    const logistics = discovery.logistics.find(
      (candidate) => candidate.id === parsed.data.logisticsId,
    );
    const warehouse = discovery.warehouses.find(
      (candidate) =>
        candidate.isAuth !== false &&
        candidate.code === parsed.data.warehouseCode,
    );
    if (!logistics || !warehouse) {
      return {
        message: "所选资源已变化，请重新发现并再次选择。",
        status: "error",
      };
    }
    await selectJifengResources({ actor, logistics, warehouse });
  } catch (error) {
    const state = businessErrorState(error);
    if (state) return state;
    throw error;
  }

  revalidateIntegrations();
  return { message: "仓库与物流渠道已确认。", status: "success" };
}

export async function runJifengDiagnosticAction(
  _previousState: JifengActionState,
  _formData: FormData,
): Promise<JifengActionState> {
  void _previousState;
  void _formData;
  const actor = await requireSuperAdmin();
  try {
    const result = await runStoredJifengDiagnostic({ actor });
    revalidateIntegrations();
    return result.ok
      ? { message: "只读连接诊断已通过。", status: "success" }
      : {
          message: "只读诊断未通过，请检查授权状态后重试。",
          status: "error",
        };
  } catch (error) {
    const state = businessErrorState(error);
    if (state) return state;
    throw error;
  }
}

export async function setJifengFulfillmentAction(
  _previousState: JifengActionState,
  formData: FormData,
): Promise<JifengActionState> {
  const actor = await requireSuperAdmin();
  const parsed = fulfillmentSchema.safeParse({
    enabled: formData.get("enabled"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return validationState(parsed.error);
  const enabled = parsed.data.enabled === "true";

  return runMutation(
    () =>
      setJifengFulfillmentEnabled({
        actor,
        enabled,
        reason: parsed.data.reason,
      }),
    enabled ? "极风自动履约已启用。" : "极风自动履约已停用。",
  );
}

export async function disconnectJifengConnectionAction(
  _previousState: JifengActionState,
  formData: FormData,
): Promise<JifengActionState> {
  const actor = await requireSuperAdmin();
  const parsed = disconnectSchema.safeParse({ reason: formData.get("reason") });
  if (!parsed.success) return validationState(parsed.error);

  return runMutation(
    () => disconnectJifengConnection({ actor, reason: parsed.data.reason }),
    "极风连接已安全断开。",
  );
}
