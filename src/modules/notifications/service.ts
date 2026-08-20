import { sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { integrationOutbox, systemNotifications } from "@/db/schema";

export async function createSystemNotification(
  tx: DbTransaction,
  input: {
    deduplicationKey: string;
    delivery?: "IN_APP_AND_FEISHU" | "IN_APP_ONLY";
    entityId?: string;
    entityType?: string;
    message: string;
    now?: Date;
    severity: "INFO" | "WARNING" | "ERROR";
    title: string;
    type: string;
  },
) {
  const now = input.now ?? new Date();
  const [notification] = await tx
    .insert(systemNotifications)
    .values({
      deduplicationKey: input.deduplicationKey,
      entityId: input.entityId,
      entityType: input.entityType,
      firstOccurredAt: now,
      lastOccurredAt: now,
      message: input.message,
      severity: input.severity,
      title: input.title,
      type: input.type,
    })
    .onConflictDoUpdate({
      set: {
        lastOccurredAt: now,
        message: input.message,
        occurrenceCount: sql`${systemNotifications.occurrenceCount} + 1`,
        readAt: null,
        resolvedAt: null,
        severity: input.severity,
        status: "UNREAD",
        title: input.title,
        updatedAt: now,
      },
      target: systemNotifications.deduplicationKey,
    })
    .returning({
      id: systemNotifications.id,
      occurrenceCount: systemNotifications.occurrenceCount,
    });

  if (input.delivery !== "IN_APP_ONLY") {
    await tx.insert(integrationOutbox).values({
      aggregateId: notification.id,
      aggregateType: "SYSTEM_NOTIFICATION",
      eventType: "FEISHU_NOTIFICATION",
      idempotencyKey: `feishu:bot:notification:${notification.id}:${notification.occurrenceCount}`,
      nextAttemptAt: now,
      payload: {
        message: input.message,
        notificationId: notification.id,
        severity: input.severity,
        title: input.title,
      },
      target: "FEISHU_BOT",
    });
  }
  return notification;
}
