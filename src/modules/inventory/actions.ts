"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import { adjustTotalInventory } from "./service";

const schema = z.object({
  delta: z.coerce.number().int("调整数量必须是整数").refine((value) => value !== 0, "调整数量不能为 0"),
  reason: z.string().trim().min(2, "请填写调整原因").max(500),
  skuId: z.string().uuid(),
});

export async function adjustInventoryAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = schema.safeParse({
    delta: formData.get("delta"),
    reason: formData.get("reason"),
    skuId: formData.get("skuId"),
  });
  if (!parsed.success) {
    return {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      status: "error",
    };
  }
  const input = parsed.data;

  try {
    await db.transaction((tx) =>
      adjustTotalInventory(tx, {
        actorId: principal.userId,
        actorType: "ADMIN",
        delta: input.delta,
        reason: input.reason,
        skuId: input.skuId,
      }),
    );
  } catch {
    return {
      message: "库存调整失败：调整后总库存不能低于已锁定数量。",
      status: "error",
    };
  }

  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
  return { message: "库存已调整并记录流水。", status: "success" };
}
