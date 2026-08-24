"use server";

import { inArray } from "drizzle-orm";
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
  const ids = z.array(z.string().uuid()).min(1).max(200).safeParse(
    formData.getAll("notificationId"),
  );
  if (!ids.success) return { message: "通知编号无效。", status: "error" };
  const now = new Date();
  await db
    .update(systemNotifications)
    .set({ readAt: now, status: "READ", updatedAt: now })
    .where(inArray(systemNotifications.id, ids.data));
  revalidatePath("/admin/notifications");
  return {
    message: ids.data.length > 1 ? `已将 ${ids.data.length} 条通知标记为已读。` : "通知已标记为已读。",
    status: "success",
  };
}
