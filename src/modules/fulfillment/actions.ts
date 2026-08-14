"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/modules/identity/guards";
import { resolveAdminUserId } from "@/modules/identity/admin-profile";
import { getEnabledJifengWriteClient } from "@/modules/jifeng-connection/provider";
import type { ActionState } from "@/shared/action-state";

import { retryJifengShipment } from "./dispatch";
import {
  cancelJifengShipment,
  createReplacementRequest,
  ReplacementError,
} from "./replacement";

const shipmentSchema = z.object({
  reason: z.string().trim().min(2, "请填写至少 2 个字的操作原因").max(1000),
  shipmentId: z.string().uuid(),
});

function failure(error: unknown, fallback: string): ActionState {
  return {
    message:
      error instanceof ReplacementError || error instanceof Error
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
  return { message: "补发已创建并锁定库存，等待极风履约。", status: "success" };
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
  try {
    const { client } = await getEnabledJifengWriteClient();
    await cancelJifengShipment({
      actorUserId: principal.userId,
      client,
      reason: parsed.data.reason,
      shipmentId: parsed.data.shipmentId,
    });
  } catch (error) {
    return failure(error, "极风取消失败，库存未释放。" );
  }
  refreshOrder(orderId);
  return { message: "极风已确认取消，相关库存锁定已释放。", status: "success" };
}
