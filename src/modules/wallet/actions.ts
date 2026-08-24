"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  WalletInsufficientFundsError,
  WalletValidationError,
  adjustWalletBalance,
} from "./service";

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, "金额最多保留两位小数")
  .transform((value) => Math.round(Number(value) * 100))
  .refine((value) => value > 0, "金额必须大于 0");

const schema = z.object({
  amountFen: moneySchema,
  customerId: z.string().uuid("请选择客户"),
  operation: z.enum(["CREDIT", "DEBIT"]),
  requestId: z.string().uuid(),
  reason: z.string().trim().min(2, "请填写调整原因").max(300),
});

export async function adjustWalletAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = schema.safeParse({
    amountFen: formData.get("amountYuan"),
    customerId: formData.get("customerId"),
    operation: formData.get("operation"),
    requestId: formData.get("requestId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      status: "error",
    };
  }

  try {
    await adjustWalletBalance({
      actorUserId: principal.userId,
      customerId: parsed.data.customerId,
      deltaFen:
        parsed.data.operation === "CREDIT"
          ? parsed.data.amountFen
          : -parsed.data.amountFen,
      idempotencyKey: parsed.data.requestId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    if (error instanceof WalletInsufficientFundsError) {
      return { status: "error", message: "客户余额不足，不能完成该扣减。" };
    }
    if (error instanceof WalletValidationError) {
      return { status: "error", message: error.message };
    }
    return { status: "error", message: "余额调整失败，请稍后重试。" };
  }

  revalidatePath("/admin/settlement");
  revalidatePath("/admin/wallets");
  revalidatePath("/portal/wallet");
  return { status: "success", message: "余额已调整并写入资金流水。" };
}
