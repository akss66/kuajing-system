"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { systemNotifications } from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

export async function markNotificationReadAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("notificationId"));
  if (!id.success) return { message: "通知编号无效。", status: "error" };
  const now = new Date();
  await db
    .update(systemNotifications)
    .set({ readAt: now, status: "READ", updatedAt: now })
    .where(eq(systemNotifications.id, id.data));
  revalidatePath("/admin/notifications");
  return { message: "通知已标记为已读。", status: "success" };
}
