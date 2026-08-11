import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  integrationAttempts,
  integrationOutbox,
  systemNotifications,
} from "@/db/schema";
import { FeishuApiError } from "@/integrations/feishu/client";
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

  test("records permission failures without leaking secrets", async () => {
    const now = new Date("2026-08-12T06:00:00.000Z");
    await enqueueFeishuCargoSync({ now, reason: "permission-check" });

    const result = await processFeishuOutbox({
      botClient: { async sendTextMessage() {} },
      cargoClient: {
        async listSheets() {
          throw new FeishuApiError(
            "1310213",
            "飞书文档权限不足，请将应用添加为知识库或电子表格协作者",
            false,
          );
        },
        async readRange() {
          return [];
        },
        async resolveWikiSpreadsheet() {
          return { spreadsheetToken: "not-used" };
        },
        async writeRange() {},
      },
      config: { cargoWikiToken: "wiki-1", internalChatId: "chat-1" },
      now,
    });

    expect(result).toEqual({ botCompleted: 0, cargoCompleted: 0, failed: 1 });
    expect(await db.select().from(integrationOutbox)).toEqual([
      expect.objectContaining({
        lastErrorCode: "1310213",
        lastErrorMessage: "飞书文档权限不足，请将应用添加为知识库或电子表格协作者",
        status: "FAILED",
      }),
    ]);
    expect(await db.select().from(integrationAttempts)).toEqual([
      expect.objectContaining({ outcome: "PERMANENT_FAILURE" }),
    ]);
  });

  test("retries a transient cargo failure after the backoff window", async () => {
    const now = new Date("2026-08-12T06:30:00.000Z");
    await enqueueFeishuCargoSync({ now, reason: "transient-failure" });
    let fail = true;
    const cargoClient = {
      async listSheets() {
        if (fail) throw new Error("temporary outage");
        return [{ index: 0, sheetId: "sheet-1", title: "货盘" }];
      },
      async readRange() {
        return [];
      },
      async resolveWikiSpreadsheet() {
        return { spreadsheetToken: "spreadsheet-1" };
      },
      async writeRange() {},
    };
    const baseInput = {
      botClient: { async sendTextMessage() {} },
      cargoClient,
      config: { cargoWikiToken: "wiki-1", internalChatId: "chat-1" },
    };

    await expect(processFeishuOutbox({ ...baseInput, now })).resolves.toMatchObject({ failed: 1 });
    fail = false;
    await expect(
      processFeishuOutbox({
        ...baseInput,
        now: new Date(now.getTime() + 5 * 60_000),
      }),
    ).resolves.toMatchObject({ cargoCompleted: 1, failed: 0 });

    expect(await db.select().from(integrationOutbox)).toEqual([
      expect.objectContaining({ attemptCount: 2, status: "COMPLETED" }),
    ]);
    expect((await db.select().from(integrationAttempts)).map((attempt) => attempt.outcome)).toEqual([
      "RETRYABLE_FAILURE",
      "SUCCESS",
    ]);
  });
});
