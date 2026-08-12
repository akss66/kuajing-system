"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { adminUsers, authUsers } from "@/db/schema";
import { requireAdmin, requireCustomer } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  SettlementBatchError,
  reportSettlementPayment,
  reviewSettlementPayment,
  withdrawSettlementPayment,
} from "./batch-service";

const yuanSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, "金额最多保留两位小数")
  .transform((value) => Math.round(Number(value) * 100))
  .refine((value) => value > 0 && value <= 2_147_483_647, "付款金额无效");

const reportSchema = z.object({
  amountFen: yuanSchema,
  note: z.string().trim().max(500, "付款备注不能超过 500 个字符").optional(),
  settlementBatchId: z.string().uuid("结算批次编号无效"),
});

const withdrawSchema = z.object({
  reason: z.string().trim().min(2, "请填写撤回原因").max(1000, "撤回原因不能超过 1000 个字符"),
  settlementBatchId: z.string().uuid("结算批次编号无效"),
});

const reviewSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    rejectionReason: z.string().trim().max(1000, "拒绝原因不能超过 1000 个字符").optional(),
    settlementBatchId: z.string().uuid("结算批次编号无效"),
  })
  .superRefine((value, context) => {
    if (value.decision === "REJECT" && !value.rejectionReason) {
      context.addIssue({
        code: "custom",
        message: "拒绝付款声明必须填写原因",
        path: ["rejectionReason"],
      });
    }
  });

function validationState(error: z.ZodError): ActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

function serviceErrorState(error: unknown, fallback: string): ActionState {
  return error instanceof SettlementBatchError
    ? { message: error.message, status: "error" }
    : { message: fallback, status: "error" };
}

async function resolveActiveAdminUserId(authUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(authUsers)
    .innerJoin(
      adminUsers,
      sql`lower(${adminUsers.loginIdentifier}) = lower(${authUsers.email})`,
    )
    .where(and(eq(authUsers.id, authUserId), eq(adminUsers.status, "ACTIVE")))
    .limit(1);
  if (!admin) throw new SettlementBatchError("ADMIN_FORBIDDEN", "管理员账号无权审核付款声明");
  return admin.id;
}

function revalidateSettlement(settlementBatchId: string) {
  revalidatePath(`/portal/settlements/${settlementBatchId}`);
  revalidatePath("/portal/orders");
  revalidatePath("/portal/wallet");
  revalidatePath("/admin/settlement");
  revalidatePath("/admin/orders");
}

export async function reportSettlementPaymentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireCustomer();
  const parsed = reportSchema.safeParse({
    amountFen: formData.get("amountYuan"),
    note: formData.get("note") || undefined,
    settlementBatchId: formData.get("settlementBatchId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  try {
    await reportSettlementPayment({
      actorUserId: principal.userId,
      amountFen: parsed.data.amountFen,
      customerId: principal.customerId,
      note: parsed.data.note,
      settlementBatchId: parsed.data.settlementBatchId,
    });
  } catch (error) {
    return serviceErrorState(error, "付款声明提交失败，请稍后重试。");
  }
  revalidateSettlement(parsed.data.settlementBatchId);
  return { message: "付款声明已提交，等待管理员统一核款。", status: "success" };
}

export async function withdrawSettlementPaymentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireCustomer();
  const parsed = withdrawSchema.safeParse({
    reason: formData.get("reason"),
    settlementBatchId: formData.get("settlementBatchId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  try {
    await withdrawSettlementPayment({
      actorUserId: principal.userId,
      customerId: principal.customerId,
      reason: parsed.data.reason,
      settlementBatchId: parsed.data.settlementBatchId,
    });
  } catch (error) {
    return serviceErrorState(error, "撤回付款声明失败，请稍后重试。");
  }
  revalidateSettlement(parsed.data.settlementBatchId);
  return { message: "付款声明已撤回，结算批次及相关拿货单已取消。", status: "success" };
}

export async function reviewSettlementPaymentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = reviewSchema.safeParse({
    decision: formData.get("decision"),
    rejectionReason: formData.get("rejectionReason") || undefined,
    settlementBatchId: formData.get("settlementBatchId"),
  });
  if (!parsed.success) return validationState(parsed.error);
  try {
    await reviewSettlementPayment({
      adminUserId: await resolveActiveAdminUserId(principal.userId),
      decision: parsed.data.decision,
      rejectionReason: parsed.data.rejectionReason,
      settlementBatchId: parsed.data.settlementBatchId,
    });
  } catch (error) {
    return serviceErrorState(error, "结算批次核款失败，请稍后重试。");
  }
  revalidateSettlement(parsed.data.settlementBatchId);
  return {
    message:
      parsed.data.decision === "APPROVE"
        ? "已确认收款，批次内拿货单进入待发货。"
        : "已拒绝付款声明并关闭整个结算批次。",
    status: "success",
  };
}
