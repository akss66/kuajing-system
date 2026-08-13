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
  enqueueCargoSyncEvent,
  enqueueFeishuCargoSync,
  processFeishuOutbox,
} from "@/modules/feishu/outbox";
import { createSystemNotification } from "@/modules/notifications/service";

const originalEnv = { ...process.env };

function replaceProcessEnv(next: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function setFeishuWriterEnv() {
  replaceProcessEnv({
    ...originalEnv,
    FEISHU_APP_ID: "app",
    FEISHU_APP_SECRET: "secret",
    FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-1",
    FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "spreadsheet-target",
    FEISHU_CARGO_TARGET_SHEET_ID: "sheet-1",
  });
}

function setFeishuSourceOnlyEnv() {
  replaceProcessEnv({
    ...originalEnv,
    FEISHU_APP_ID: "app",
    FEISHU_APP_SECRET: "secret",
    FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-1",
    FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: undefined,
    FEISHU_CARGO_TARGET_SHEET_ID: undefined,
  });
}

describe("Feishu integration outbox", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        integration_outbox,
        system_notifications
      restart identity cascade
    `));
    replaceProcessEnv(originalEnv);
  });

  test("pushes sanitized messages and coalesces multiple cargo events into one write", async () => {
    setFeishuWriterEnv();
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
    await db.transaction((tx) =>
      enqueueCargoSyncEvent(tx, {
        idempotencyKey: "cargo-1",
        now,
        reason: "inventory-changed",
      }),
    );
    await db.transaction((tx) =>
      enqueueCargoSyncEvent(tx, {
        idempotencyKey: "cargo-2",
        now,
        reason: "duplicate-slot",
      }),
    );

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
          return { spreadsheetToken: "spreadsheet-source" };
        },
        async writeRange() {
          cargoWrites += 1;
        },
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      now,
    });

    expect(result).toEqual({ botCompleted: 2, cargoCompleted: 2, failed: 0 });
    expect(cargoWrites).toBe(1);
    expect(sentMessages.sort()).toEqual([
      "【同舟行跨境】低库存预警\nTZX-001 可售库存仅剩 3 件，请安排补货。",
      "【同舟行跨境】低库存预警\nTZX-001 可售库存仅剩 2 件，请安排补货。",
    ].sort());
    const [notification] = await db.select().from(systemNotifications);
    expect(notification).toMatchObject({ occurrenceCount: 2, status: "UNREAD" });
    expect((await db.select().from(integrationOutbox)).every((event) => event.status === "COMPLETED")).toBe(true);
    expect(await db.select().from(integrationAttempts)).toHaveLength(4);
  });

  test("records permission failures without leaking secrets", async () => {
    setFeishuWriterEnv();
    const now = new Date("2026-08-12T06:00:00.000Z");
    await db.transaction((tx) =>
      enqueueCargoSyncEvent(tx, {
        idempotencyKey: "permission-check",
        now,
        reason: "permission-check",
      }),
    );

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
          return { spreadsheetToken: "spreadsheet-source" };
        },
        async writeRange() {},
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
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
    setFeishuWriterEnv();
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
        return { spreadsheetToken: "spreadsheet-source" };
      },
      async writeRange() {},
    };
    const baseInput = {
      botClient: { async sendTextMessage() {} },
      cargoClient,
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
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

  test("does not enqueue cargo events when target writing is disabled", async () => {
    setFeishuSourceOnlyEnv();
    const now = new Date("2026-08-12T07:00:00.000Z");
    await db.transaction((tx) =>
      enqueueCargoSyncEvent(tx, {
        idempotencyKey: "source-only-transaction",
        now,
        reason: "source-only-config",
      }),
    );

    await expect(
      enqueueFeishuCargoSync({ now, reason: "source-only-scheduled" }),
    ).resolves.toBe(false);

    expect(await db.select().from(integrationOutbox)).toHaveLength(0);
    expect(await db.select().from(integrationAttempts)).toHaveLength(0);
  });
});
