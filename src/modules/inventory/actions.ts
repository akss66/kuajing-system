"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { requireAdmin } from "@/modules/identity/guards";

import { adjustTotalInventory } from "./service";

const schema = z.object({
  delta: z.coerce.number().int("调整数量必须是整数").refine((value) => value !== 0, "调整数量不能为 0"),
  reason: z.string().trim().min(2, "请填写调整原因").max(500),
  skuId: z.string().uuid(),
});

export async function adjustInventoryAction(formData: FormData) {
  const principal = await requireAdmin();
  const input = schema.parse({
    delta: formData.get("delta"),
    reason: formData.get("reason"),
    skuId: formData.get("skuId"),
  });

  await db.transaction((tx) =>
    adjustTotalInventory(tx, {
      actorId: principal.userId,
      actorType: "ADMIN",
      delta: input.delta,
      reason: input.reason,
      skuId: input.skuId,
    }),
  );

  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
}
