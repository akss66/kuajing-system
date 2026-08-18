"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  adjustTotalInventory,
  InsufficientInventoryError,
  InventoryBalanceNotFoundError,
  InventoryValidationError,
  setInventoryToActualCount,
} from "./service";
import {
  DEFAULT_MANUAL_INVENTORY_REASON,
  INVENTORY_MOVEMENT_REASON_CODES,
  isManualInventoryReasonCode,
} from "./types";

const schema = z.object({
  direction: z.enum(["INCREASE", "DECREASE"]),
  quantity: z.coerce
    .number()
    .int("调整数量必须是整数")
    .positive("调整数量必须是正整数")
    .refine(Number.isSafeInteger, "调整数量超出允许范围"),
  reasonCode: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.enum(INVENTORY_MOVEMENT_REASON_CODES).optional(),
  ),
  remark: z.preprocess(
    (value) =>
      value === null || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z.string().trim().max(1000, "备注不能超过 1000 个字符").optional(),
  ),
  skuId: z.string().uuid(),
});

const stocktakeSchema = z.object({
  actualTotalQuantity: z.coerce
    .number()
    .int("实际总库存必须是整数")
    .nonnegative("实际总库存不能为负数")
    .refine(Number.isSafeInteger, "实际总库存超出允许范围"),
  reasonCode: z.literal("STOCKTAKE_CORRECTION"),
  remark: z.preprocess(
    (value) =>
      value === null || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z.string().trim().max(1000, "备注不能超过 1000 个字符").optional(),
  ),
  skuId: z.string().uuid(),
});

export async function adjustInventoryAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = schema.safeParse({
    direction: formData.get("direction"),
    quantity: formData.get("quantity"),
    reasonCode: formData.get("reasonCode"),
    remark: formData.get("remark"),
    skuId: formData.get("skuId"),
  });
  if (!parsed.success) {
    return {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      status: "error",
    };
  }
  const input = parsed.data;
  const reasonCode =
    input.reasonCode ?? DEFAULT_MANUAL_INVENTORY_REASON[input.direction];
  if (!isManualInventoryReasonCode(input.direction, reasonCode)) {
    return {
      fieldErrors: {
        reasonCode: ["所选原因不适用于当前库存调整方向"],
      },
      status: "error",
    };
  }

  try {
    await db.transaction((tx) =>
      adjustTotalInventory(tx, {
        actorId: principal.userId,
        actorType: "ADMIN",
        direction: input.direction,
        quantity: input.quantity,
        reasonCode,
        remark: input.remark,
        skuId: input.skuId,
      }),
    );
  } catch (error) {
    if (error instanceof InsufficientInventoryError) {
      return {
        message: "库存调整失败：调整后总库存不能低于已锁定数量。",
        status: "error",
      };
    }
    if (error instanceof InventoryBalanceNotFoundError) {
      return {
        message: "未找到对应 SKU 库存，请刷新页面后重试。",
        status: "error",
      };
    }
    if (error instanceof InventoryValidationError) {
      return { message: "库存调整参数无效，请刷新后重试。", status: "error" };
    }
    throw error;
  }

  revalidatePath("/admin/inventory");
  revalidatePath("/admin/inventory/movements");
  revalidatePath("/admin");
  return { message: "库存已调整并记录流水。", status: "success" };
}

export async function setInventoryToActualCountAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = stocktakeSchema.safeParse({
    actualTotalQuantity: formData.get("actualTotalQuantity"),
    reasonCode: formData.get("reasonCode"),
    remark: formData.get("remark"),
    skuId: formData.get("skuId"),
  });
  if (!parsed.success) {
    return {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<
        string,
        string[]
      >,
      status: "error",
    };
  }

  try {
    const result = await db.transaction((tx) =>
      setInventoryToActualCount(tx, {
        actorId: principal.userId,
        actorType: "ADMIN",
        ...parsed.data,
      }),
    );
    if (result.status === "NO_CHANGE") {
      return {
        message: "库存与盘点结果一致，未生成库存流水。",
        status: "success",
      };
    }
  } catch (error) {
    if (error instanceof InsufficientInventoryError) {
      return {
        message: "盘点调整失败：实际总库存不能低于已锁定数量。",
        status: "error",
      };
    }
    if (error instanceof InventoryBalanceNotFoundError) {
      return {
        message: "未找到对应 SKU 库存，请刷新页面后重试。",
        status: "error",
      };
    }
    if (error instanceof InventoryValidationError) {
      return { message: "盘点参数无效，请刷新后重试。", status: "error" };
    }
    throw error;
  }

  revalidatePath("/admin/inventory");
  revalidatePath("/admin/inventory/movements");
  revalidatePath("/admin");
  return { message: "盘点库存已更新并记录流水。", status: "success" };
}
