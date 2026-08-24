import { describe, expect, it } from "vitest";

import { groupSystemNotifications } from "@/modules/notifications/presentation";

const occurredAt = new Date("2026-08-24T08:00:00.000Z");

function notification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: occurredAt,
    deduplicationKey: `jifeng-match:${id}`,
    entityId: id,
    entityType: "ORDER_SHIPMENT",
    firstOccurredAt: occurredAt,
    id,
    lastOccurredAt: occurredAt,
    message: "系统多次未在极风找到该平台订单，请确认极风订单是否已导入。",
    occurrenceCount: 1,
    readAt: null,
    resolvedAt: null,
    severity: "WARNING" as const,
    status: "UNREAD" as const,
    title: "极风订单仍待匹配",
    type: "JIFENG_ORDER_MATCH_PENDING",
    updatedAt: occurredAt,
    ...overrides,
  };
}

describe("groupSystemNotifications", () => {
  it("collapses the same operational problem across packages without losing notification ids", () => {
    const groups = groupSystemNotifications([
      notification("shipment-1"),
      notification("shipment-2", { occurrenceCount: 3 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      affectedEntityCount: 2,
      notificationIds: ["shipment-1", "shipment-2"],
      occurrenceCount: 4,
      status: "UNREAD",
      title: "极风订单仍待匹配",
    });
  });

  it("does not merge unrelated messages that happen to share a title", () => {
    const groups = groupSystemNotifications([
      notification("shipment-1"),
      notification("shipment-2", { message: "请在极风后台提交仓库。" }),
    ]);

    expect(groups).toHaveLength(2);
  });
});
