export type SystemNotificationPresentationInput = {
  entityId: string | null;
  entityType: string | null;
  id: string;
  lastOccurredAt: Date;
  message: string;
  occurrenceCount: number;
  severity: "INFO" | "WARNING" | "ERROR";
  status: "UNREAD" | "READ" | "RESOLVED";
  title: string;
  type: string;
};

export type SystemNotificationGroup = SystemNotificationPresentationInput & {
  affectedEntityCount: number;
  notificationIds: string[];
};

function groupKey(notification: SystemNotificationPresentationInput) {
  return JSON.stringify([
    notification.type,
    notification.severity,
    notification.entityType,
    notification.title,
    notification.message,
  ]);
}

function combinedStatus(
  current: SystemNotificationGroup["status"],
  next: SystemNotificationPresentationInput["status"],
) {
  if (current === "UNREAD" || next === "UNREAD") return "UNREAD";
  if (current === "READ" || next === "READ") return "READ";
  return "RESOLVED";
}

export function groupSystemNotifications(
  notifications: SystemNotificationPresentationInput[],
): SystemNotificationGroup[] {
  const grouped = new Map<
    string,
    { entityIds: Set<string>; group: SystemNotificationGroup }
  >();

  for (const notification of notifications) {
    const key = groupKey(notification);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        entityIds: new Set(notification.entityId ? [notification.entityId] : [notification.id]),
        group: {
          ...notification,
          affectedEntityCount: 1,
          notificationIds: [notification.id],
        },
      });
      continue;
    }

    if (notification.entityId) existing.entityIds.add(notification.entityId);
    else existing.entityIds.add(notification.id);
    existing.group.affectedEntityCount = existing.entityIds.size;
    existing.group.notificationIds.push(notification.id);
    existing.group.occurrenceCount += notification.occurrenceCount;
    existing.group.status = combinedStatus(existing.group.status, notification.status);
    if (notification.lastOccurredAt > existing.group.lastOccurredAt) {
      existing.group.lastOccurredAt = notification.lastOccurredAt;
    }
  }

  return Array.from(grouped.values(), ({ group }) => group).sort(
    (left, right) => right.lastOccurredAt.getTime() - left.lastOccurredAt.getTime(),
  );
}
