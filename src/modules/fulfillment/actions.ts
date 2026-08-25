"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { JifengApiError } from "@/integrations/jifeng/client";
import { requireAdmin } from "@/modules/identity/guards";
import { resolveAdminUserId } from "@/modules/identity/admin-profile";
import {
  getEnabledJifengCancellationClient,
  getJifengReadClient,
} from "@/modules/jifeng-connection/provider";
import { SettlementBatchError } from "@/modules/settlement/batch-service";
import type { ActionState } from "@/shared/action-state";

import { JifengDispatchError, retryJifengShipment } from "./dispatch";
import {
  cancelAllCancellableOrderShipments,
  completeAllOfflineOrderRefunds,
  OrderOperationsError,
  refreshAllJifengShipmentStatuses,
} from "./order-operations";
import {
  cancelJifengShipment,
  createReplacementRequest,
  ReplacementError,
} from "./replacement";
import {
  JifengStatusRefreshError,
  refreshJifengShipmentStatus,
} from "./status-sync";

const shipmentSchema = z.object({
  reason: z.string().trim().min(2, "请填写至少 2 个字的操作原因").max(1000),
  shipmentId: z.string().uuid(),
});

const offlineRefundSchema = z.object({
  adjustmentId: z.string().uuid(),
  note: z.string().trim().min(2, "请填写至少 2 个字的退款凭证或备注").max(1000),
});

const refreshShipmentSchema = z.object({
  shipmentId: z.string().uuid(),
});

const orderOperationSchema = z.object({
  orderId: z.string().uuid(),
});

const cancelOrderShipmentsSchema = orderOperationSchema.extend({
  reason: z.string().trim().min(2, "请填写至少 2 个字的取消原因").max(1000),
});

const completeOrderRefundsSchema = orderOperationSchema.extend({
  note: z.string().trim().min(2, "请填写至少 2 个字的退款凭证或备注").max(1000),
});

const SAFE_TEMU_PLATFORM_ORDER_NO = /^PO-\d{3}-\d{10,32}$/i;
const MAX_FAILED_REFERENCES = 5;

function failedShipmentSummary(
  items: ReadonlyArray<{
    externalOrderNo: string;
    outcome: string;
  }>,
) {
  const failed = items.flatMap((item, index) => {
    if (item.outcome !== "FAILED") return [];
    const externalOrderNo = item.externalOrderNo.trim();
    return [
      SAFE_TEMU_PLATFORM_ORDER_NO.test(externalOrderNo)
        ? externalOrderNo
        : `包裹序号 ${index + 1}`,
    ];
  });
  if (failed.length === 0) return "";
  const hiddenCount = Math.max(0, failed.length - MAX_FAILED_REFERENCES);
  const hiddenCopy =
    hiddenCount > 0 ? `，另有 ${hiddenCount} 个请在包裹明细中查看` : "";
  return `失败包裹：${failed.slice(0, MAX_FAILED_REFERENCES).join("、")}${hiddenCopy}。`;
}

function safeStatusRefreshMessage(error: JifengStatusRefreshError) {
  switch (error.code) {
    case "FULFILLMENT_NOT_FOUND":
      return "未找到该包裹的极风履约记录。";
    case "STATUS_REFRESH_IN_PROGRESS":
      return "该包裹正在同步极风状态，请稍后再试。";
    case "STATUS_NOT_REFRESHABLE":
      return "当前包裹还不能直接查询极风状态。";
    case "STATUS_REFRESH_STALE":
      return "本次极风状态查询已过期，请重新查询。";
    default:
      return "极风状态同步失败，请稍后重试。";
  }
}

function failure(error: unknown, fallback: string): ActionState {
  return {
    message:
      error instanceof ReplacementError ||
      error instanceof OrderOperationsError ||
      (error instanceof Error && error.name === "OrderLifecycleError") ||
      error instanceof JifengDispatchError ||
      error instanceof SettlementBatchError ||
      (error instanceof Error && error.name === "PackageCancellationAdjustmentError")
        ? error.message
        : fallback,
    status: "error",
  };
}

function refreshOrder(orderId: string) {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
}

function refreshOrderFinancials(orderId: string) {
  refreshOrder(orderId);
  revalidatePath(`/portal/orders/${orderId}`);
  revalidatePath("/admin/payments");
  revalidatePath("/portal/wallet");
}

export async function refreshAllJifengShipmentStatusesAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const parsed = orderOperationSchema.safeParse({ orderId: formData.get("orderId") });
  if (!parsed.success) return { message: "拿货单信息无效。", status: "error" };
  try {
    const { client } = await getJifengReadClient();
    const result = await refreshAllJifengShipmentStatuses({
      client,
      orderId: parsed.data.orderId,
    });
    refreshOrder(parsed.data.orderId);
    const failureSummary = failedShipmentSummary(result.items);
    const message = `整单状态查询完成：已更新 ${result.refreshedCount} 个，跳过 ${result.skippedCount} 个，失败 ${result.failedCount} 个。${failureSummary}`;
    return {
      message,
      status: result.failedCount > 0 ? "error" : "success",
    };
  } catch (error) {
    return failure(error, "整单极风状态查询失败，请稍后重试。");
  }
}

export async function cancelAllCancellableOrderShipmentsAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = cancelOrderShipmentsSchema.safeParse({
    orderId: formData.get("orderId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, status: "error" };
  }
  try {
    const result = await cancelAllCancellableOrderShipments({
      actorUserId: principal.userId,
      getClient: async () => (await getEnabledJifengCancellationClient()).client,
      orderId: parsed.data.orderId,
      reason: parsed.data.reason,
    });
    refreshOrderFinancials(parsed.data.orderId);
    const failureSummary = failedShipmentSummary(result.items);
    const message = `整单取消处理完成：已取消 ${result.cancelledCount} 个，等待极风确认 ${result.pendingCount} 个，跳过 ${result.skippedCount} 个，失败 ${result.failedCount} 个。${failureSummary}`;
    return {
      message,
      status: result.failedCount > 0 ? "error" : "success",
    };
  } catch (error) {
    return failure(error, "整单取消失败，未确认取消的包裹不会释放库存。");
  }
}

export async function completeAllOfflineOrderRefundsAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = completeOrderRefundsSchema.safeParse({
    note: formData.get("note"),
    orderId: formData.get("orderId"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, status: "error" };
  }
  try {
    const result = await completeAllOfflineOrderRefunds({
      actorUserId: principal.userId,
      adminUserId: await resolveAdminUserId(principal.userId),
      note: parsed.data.note,
      orderId: parsed.data.orderId,
    });
    refreshOrderFinancials(parsed.data.orderId);
    return {
      message:
        result.status === "ALREADY_COMPLETED"
          ? "该拿货单的线下退款已全部确认，无需重复处理。"
          : `已确认 ${result.completedCount} 笔线下退款，共 ${(
              result.completedAmountFen / 100
            ).toFixed(2)} 元，并写入审计记录。`,
      status: "success",
    };
  } catch (error) {
    return failure(error, "整单线下退款确认失败，请稍后重试。");
  }
}

export async function createReplacementAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = shipmentSchema.safeParse({
    reason: formData.get("reason"),
    shipmentId: formData.get("shipmentId"),
  });
  const orderId = String(formData.get("orderId") ?? "");
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, status: "error" };
  }
  const items = [...formData.entries()]
    .filter(([key]) => key.startsWith("quantity:"))
    .map(([key, value]) => ({
      quantity: Number(value),
      skuId: key.slice("quantity:".length),
    }))
    .filter((item) => Number.isSafeInteger(item.quantity) && item.quantity > 0);
  try {
    await createReplacementRequest({
      actorUserId: principal.userId,
      adminUserId: await resolveAdminUserId(principal.userId),
      items,
      originalShipmentId: parsed.data.shipmentId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    return failure(error, "补发创建失败，请稍后重试。");
  }
  refreshOrder(orderId);
  return {
    message: "补发已创建并锁定库存，系统将等待匹配极风已有订单。",
    status: "success",
  };
}

export async function retryJifengShipmentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = shipmentSchema.safeParse({
    reason: formData.get("reason"),
    shipmentId: formData.get("shipmentId"),
  });
  const orderId = String(formData.get("orderId") ?? "");
  if (!parsed.success) return { status: "error", message: "包裹或重试原因无效。" };
  try {
    await retryJifengShipment({
      actorUserId: principal.userId,
      reason: parsed.data.reason,
      shipmentId: parsed.data.shipmentId,
    });
  } catch (error) {
    return failure(error, "极风重试提交失败。");
  }
  refreshOrder(orderId);
  return { message: "已加入极风重试队列。", status: "success" };
}

export async function refreshJifengShipmentStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const parsed = refreshShipmentSchema.safeParse({
    shipmentId: formData.get("shipmentId"),
  });
  if (!parsed.success) {
    return { message: "包裹信息无效。", status: "error" };
  }
  try {
    const { client } = await getJifengReadClient();
    const result = await refreshJifengShipmentStatus({
      client,
      shipmentId: parsed.data.shipmentId,
    });
    refreshOrder(result.orderId);
    return {
      message:
        result.status === "ALREADY_CANCELLED" || result.status === "CANCELLED"
          ? "已重新核对极风状态，取消状态和父拿货单进度已同步。"
          : "已重新核对极风状态，页面进度已更新。",
      status: "success",
    };
  } catch (error) {
    if (error instanceof JifengStatusRefreshError) {
      return { message: safeStatusRefreshMessage(error), status: "error" };
    }
    if (error instanceof JifengApiError) {
      return {
        message: "极风状态查询暂时失败，请检查外部集成后稍后再试。",
        status: "error",
      };
    }
    return { message: "极风状态同步失败，请稍后重试。", status: "error" };
  }
}

export async function cancelJifengShipmentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = shipmentSchema.safeParse({
    reason: formData.get("reason"),
    shipmentId: formData.get("shipmentId"),
  });
  const orderId = String(formData.get("orderId") ?? "");
  if (!parsed.success) return { status: "error", message: "包裹或取消原因无效。" };
  let cancellationResult: Awaited<ReturnType<typeof cancelJifengShipment>>;
  try {
    try {
      cancellationResult = await cancelJifengShipment({
        actorUserId: principal.userId,
        reason: parsed.data.reason,
        shipmentId: parsed.data.shipmentId,
      });
    } catch (error) {
      if (!(error instanceof ReplacementError) || error.code !== "JIFENG_CLIENT_REQUIRED") {
        throw error;
      }
      const { client } = await getEnabledJifengCancellationClient();
      cancellationResult = await cancelJifengShipment({
        actorUserId: principal.userId,
        client,
        reason: parsed.data.reason,
        shipmentId: parsed.data.shipmentId,
      });
    }
  } catch (error) {
    return failure(error, "极风取消失败，库存未释放。" );
  }
  refreshOrder(orderId);
  if (cancellationResult.status === "CANCEL_PENDING") {
    return {
      message: "极风已接收取消请求，系统将在确认远端状态 9 后释放库存和生成退款记录。",
      status: "success",
    };
  }
  return {
    message: "包裹已取消，库存已释放；系统已同步生成应付冲减或退款记录。",
    status: "success",
  };
}

export async function completeOfflinePackageRefundAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = offlineRefundSchema.safeParse({
    adjustmentId: formData.get("adjustmentId"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, status: "error" };
  }
  let trustedOrderId: string;
  try {
    const { completeOfflinePackageRefund } = await import(
      "./package-cancellation-adjustment"
    );
    const result = await completeOfflinePackageRefund({
      actorUserId: principal.userId,
      adjustmentId: parsed.data.adjustmentId,
      adminUserId: await resolveAdminUserId(principal.userId),
      note: parsed.data.note,
    });
    trustedOrderId = result.orderId;
  } catch (error) {
    return failure(error, "线下退款确认失败，请稍后重试。");
  }
  refreshOrder(trustedOrderId);
  revalidatePath(`/portal/orders/${trustedOrderId}`);
  return { message: "线下退款已确认完成并写入审计记录。", status: "success" };
}
