"use server";

import { refresh, revalidatePath } from "next/cache";
import { z } from "zod";

import { InsufficientInventoryError } from "@/modules/inventory/service";
import { requireCustomer } from "@/modules/identity/guards";

import type { SubmitOrderActionState } from "./action-state";
import { OrderSubmissionError, submitTemuImportBatch } from "./submission";

export async function submitImportBatchAction(
  _previousState: SubmitOrderActionState,
  formData: FormData,
): Promise<SubmitOrderActionState> {
  const principal = await requireCustomer();
  const parsed = z.string().uuid().safeParse(formData.get("batchId"));
  if (!parsed.success) return { status: "error", message: "导入预览编号无效。" };

  try {
    const order = await submitTemuImportBatch({
      actorUserId: principal.userId,
      batchId: parsed.data,
      customerId: principal.customerId,
    });
    revalidatePath("/portal/orders");
    revalidatePath(`/portal/orders/${order.orderId}`);
    revalidatePath("/portal/wallet");
    return {
      message:
        order.status === "PAID_PENDING_FULFILLMENT"
          ? "余额已自动扣款，订单进入待发货。"
          : "订单已提交，请完成线下付款。",
      orderId: order.orderId,
      status: "success",
    };
  } catch (error) {
    if (error instanceof InsufficientInventoryError) {
      return { status: "error", message: "部分 SKU 库存不足，请联系管理员补货后重试。" };
    }
    if (error instanceof OrderSubmissionError) {
      if (
        error.code === "SKU_NOT_SELLABLE" ||
        error.code === "INSUFFICIENT_INVENTORY"
      ) {
        refresh();
      }
      return { status: "error", message: error.message };
    }
    return { status: "error", message: "拿货单提交失败，请稍后重试。" };
  }
}
