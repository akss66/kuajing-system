import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  integrationAttempts,
  integrationOutbox,
  systemNotifications,
} from "@/db/schema";
import {
  enqueueFeishuCargoSync,
  processFeishuOutbox,
} from "@/modules/feishu/outbox";
import { createSystemNotification } from "@/modules/notifications/service";

describe("Feishu integration outbox", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        system_notifications
      restart identity cascade
    `));
  });

  test("deduplicates system notifications, pushes sanitized messages and coalesces cargo snapshots", async () => {
    const now = new Date("2026-08-12T05:10:00.000Z");
    await db.transaction((tx) =>
      createSystemNotification(tx, {
        deduplicationKey: "low-stock:TZX-001",
        entityId: "sku-1",
        entityType: "SKU",
        message: "TZX-001 可售库存仅剩 3 件，请安排补货。",
        now,
        severity: "WARNING",
        title: "低库存预警",
        type: "LOW_STOCK",
      }),
    );
    await db.transaction((tx) =>
      createSystemNotification(tx, {
        deduplicationKey: "low-stock:TZX-001",
        entityId: "sku-1",
        entityType: "SKU",
        message: "TZX-001 可售库存仅剩 2 件，请安排补货。",
        now,
        severity: "WARNING",
        title: "低库存预警",
        type: "LOW_STOCK",
      }),
    );
    expect(await enqueueFeishuCargoSync({ now, reason: "inventory-changed" })).toBe(true);
    expect(await enqueueFeishuCargoSync({ now, reason: "duplicate-slot" })).toBe(false);

    const sentMessages: string[] = [];
    let cargoWrites = 0;
    const result = await processFeishuOutbox({
      botClient: {
        async sendTextMessage(input) {
          sentMessages.push(input.text);
        },
      },
      cargoClient: {
        async listSheets() {
          return [{ index: 0, sheetId: "sheet-1", title: "货盘" }];
        },
        async readRange() {
          return [];
        },
        async resolveWikiSpreadsheet() {
          return { spreadsheetToken: "spreadsheet-1" };
        },
        async writeRange() {
          cargoWrites += 1;
        },
      },
      config: {
        cargoWikiToken: "wiki-1",
        internalChatId: "chat-1",
      },
      now,
    });

    expect(result).toEqual({ botCompleted: 2, cargoCompleted: 1, failed: 0 });
    expect(cargoWrites).toBe(1);
    expect(sentMessages.sort()).toEqual([
      "【同舟行跨境】低库存预警\nTZX-001 可售库存仅剩 3 件，请安排补货。",
      "【同舟行跨境】低库存预警\nTZX-001 可售库存仅剩 2 件，请安排补货。",
    ].sort());
    const [notification] = await db.select().from(systemNotifications);
    expect(notification).toMatchObject({ occurrenceCount: 2, status: "UNREAD" });
    expect((await db.select().from(integrationOutbox)).every((event) => event.status === "COMPLETED")).toBe(true);
    expect(await db.select().from(integrationAttempts)).toHaveLength(3);
  });
});
