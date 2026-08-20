"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { adminUsers, authUsers } from "@/db/schema";
import { requireAdmin, requireCustomer } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  OrderLifecycleError,
  cancelFulfillmentOrder,
  declareOfflinePayment,
  reviewOfflinePayment,
} from "./lifecycle";

const yuanSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, "金额最多保留两位小数")
  .transform((value) => Math.round(Number(value) * 100))
  .refine((value) => value > 0 && value <= 2_147_483_647, "付款金额无效");

const declareSchema = z.object({
  amountFen: yuanSchema,
  note: z.string().trim().max(500, "付款备注不能超过 500 个字符").optional(),
  orderId: z.string().uuid("拿货单编号无效"),
});

const cancelSchema = z.object({
  orderId: z.string().uuid("拿货单编号无效"),
  reason: z.string().trim().min(2, "请填写取消原因").max(1000, "取消原因不能超过 1000 个字符"),
});

const reviewSchema = z
  .object({
    claimId: z.string().uuid("付款声明编号无效"),
    decision: z.enum(["APPROVE", "REJECT"]),
    rejectionReason: z.string().trim().max(1000, "拒绝原因不能超过 1000 个字符").optional(),
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

function lifecycleErrorState(error: unknown, fallback: string): ActionState {
  return error instanceof OrderLifecycleError ||
    (error instanceof Error && error.name === "SettlementBatchError")
    ? { message: error.message, status: "error" }
    : { message: fallback, status: "error" };
}

async function resolveAdminUserId(authUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(authUsers)
    .innerJoin(
      adminUsers,
      sql`lower(${adminUsers.loginIdentifier}) = lower(${authUsers.email})`,
    )
    .where(
      and(
        eq(authUsers.id, authUserId),
        eq(adminUsers.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!admin) throw new Error("ADMIN_PROFILE_NOT_FOUND");
  return admin.id;
}

export async function declareOfflinePaymentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireCustomer();
  const parsed = declareSchema.safeParse({
    amountFen: formData.get("amountYuan"),
    note: formData.get("note") || undefined,
    orderId: formData.get("orderId"),
  });
  if (!parsed.success) return validationState(parsed.error);

  try {
    await declareOfflinePayment({
      actorUserId: principal.userId,
      amountFen: parsed.data.amountFen,
      customerId: principal.customerId,
      note: parsed.data.note,
      orderId: parsed.data.orderId,
    });
  } catch (error) {
    return lifecycleErrorState(error, "付款声明提交失败，请稍后重试。");
  }

  revalidatePath(`/portal/orders/${parsed.data.orderId}`);
  revalidatePath("/portal/orders");
  return { message: "付款声明已提交，库存锁定延长至 12 小时，等待管理员核款。", status: "success" };
}

export async function cancelCustomerOrderAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireCustomer();
  const parsed = cancelSchema.safeParse({
    orderId: formData.get("orderId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return validationState(parsed.error);

  try {
    await cancelFulfillmentOrder({
      actorType: "CUSTOMER",
      actorUserId: principal.userId,
      customerId: principal.customerId,
      orderId: parsed.data.orderId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    return lifecycleErrorState(error, "取消拿货单失败，请稍后重试。");
  }

  revalidatePath(`/portal/orders/${parsed.data.orderId}`);
  revalidatePath("/portal/orders");
  revalidatePath("/portal/wallet");
  return { message: "拿货单已取消，库存已释放；如有钱包扣款已原路退回。", status: "success" };
}

export async function reviewOfflinePaymentAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = reviewSchema.safeParse({
    claimId: formData.get("claimId"),
    decision: formData.get("decision"),
    rejectionReason: formData.get("rejectionReason") || undefined,
  });
  if (!parsed.success) return validationState(parsed.error);

  try {
    const reviewed = await reviewOfflinePayment({
      actorUserId: principal.userId,
      adminUserId: await resolveAdminUserId(principal.userId),
      claimId: parsed.data.claimId,
      decision: parsed.data.decision,
      rejectionReason: parsed.data.rejectionReason,
    });
    revalidatePath(`/portal/orders/${reviewed.orderId}`);
  } catch (error) {
    return lifecycleErrorState(error, "付款审核失败，请稍后重试。");
  }

  revalidatePath("/admin/settlement");
  revalidatePath("/portal/orders");
  return {
    message: parsed.data.decision === "APPROVE" ? "已确认收款，订单进入待发货。" : "已拒绝付款声明并通知客户查看原因。",
    status: "success",
  };
}

export async function cancelAdminOrderAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = cancelSchema.safeParse({
    orderId: formData.get("orderId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return validationState(parsed.error);

  try {
    await cancelFulfillmentOrder({
      actorType: "ADMIN",
      actorUserId: principal.userId,
      orderId: parsed.data.orderId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    return lifecycleErrorState(error, "取消拿货单失败，请稍后重试。");
  }

  revalidatePath("/admin/orders");
  revalidatePath("/admin/settlement");
  revalidatePath("/portal/orders");
  revalidatePath("/portal/wallet");
  return { message: "拿货单已取消并完成库存及钱包处理。", status: "success" };
}
