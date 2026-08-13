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

function setFeishuPartialTargetEnv() {
  replaceProcessEnv({
    ...originalEnv,
    FEISHU_APP_ID: "app",
    FEISHU_APP_SECRET: "secret",
    FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-1",
    FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "spreadsheet-target",
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

  test("pushes sanitized messages, resolves the source once, and coalesces cargo events into one target-only sync", async () => {
    setFeishuWriterEnv();
    const now = new Date("2026-08-12T05:10:00.000Z");
    await db.transaction((tx) =>
      createSystemNotification(tx, {
        deduplicationKey: "low-stock:TZX-001",
        entityId: "sku-1",
        entityType: "SKU",
        message: "TZX-001 鍙敭搴撳瓨浠呭墿 3 浠讹紝璇峰畨鎺掕ˉ璐с€?",
        now,
        severity: "WARNING",
        title: "浣庡簱瀛橀璀?",
        type: "LOW_STOCK",
      }),
    );
    await db.transaction((tx) =>
      createSystemNotification(tx, {
        deduplicationKey: "low-stock:TZX-001",
        entityId: "sku-1",
        entityType: "SKU",
        message: "TZX-001 鍙敭搴撳瓨浠呭墿 2 浠讹紝璇峰畨鎺掕ˉ璐с€?",
        now,
        severity: "WARNING",
        title: "浣庡簱瀛橀璀?",
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
    const syncInputs: Array<{
      config: {
        sourceSpreadsheetToken: string;
        targetSheetId: string;
        targetSpreadsheetToken: string;
      };
      readRange: {
        range: string;
        spreadsheetToken: string;
      };
    }> = [];
    let sourceResolutions = 0;

    const result = await processFeishuOutbox({
      botClient: {
        async sendTextMessage(input) {
          sentMessages.push(input.text);
        },
      },
      cargoClient: {
        async createFilter(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
        async readRange(input) {
          syncInputs.push({
            config: {
              sourceSpreadsheetToken: "spreadsheet-source",
              targetSheetId: "sheet-1",
              targetSpreadsheetToken: "spreadsheet-target",
            },
            readRange: input,
          });
          return [];
        },
        async setRangeStyle(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
        async updateDimension(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
        async updateSheetProperties(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
        async writeImage(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
        async writeRange(input) {
          expect(input.spreadsheetToken).toBe("spreadsheet-target");
        },
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      now,
      sourceClient: {
        async resolveWikiSpreadsheet(wikiToken) {
          sourceResolutions += 1;
          expect(wikiToken).toBe("wiki-1");
          return { spreadsheetToken: "spreadsheet-source" };
        },
      },
    });

    expect(result).toEqual({ botCompleted: 2, cargoCompleted: 2, failed: 0 });
    expect(sourceResolutions).toBe(1);
    expect(syncInputs).toHaveLength(1);
    expect(syncInputs[0]).toEqual({
      config: {
        sourceSpreadsheetToken: "spreadsheet-source",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      readRange: {
        range: "sheet-1!A1:M5000",
        spreadsheetToken: "spreadsheet-target",
      },
    });
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.every((message) => message.includes("【同舟行跨境】"))).toBe(
      true,
    );
    expect(sentMessages.every((message) => message.includes("TZX-001"))).toBe(true);
    expect(sentMessages.some((message) => message.includes("3 浠"))).toBe(true);
    expect(sentMessages.some((message) => message.includes("2 浠"))).toBe(true);
    const [notification] = await db.select().from(systemNotifications);
    expect(notification).toMatchObject({ occurrenceCount: 2, status: "UNREAD" });
    expect(
      (await db.select().from(integrationOutbox)).every(
        (event) => event.status === "COMPLETED",
      ),
    ).toBe(true);
    const attempts = await db.select().from(integrationAttempts);
    expect(attempts).toHaveLength(4);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "SUCCESS", responseMetadata: {} }),
        expect.objectContaining({ outcome: "SUCCESS", responseMetadata: {} }),
        expect.objectContaining({
          outcome: "SUCCESS",
          responseMetadata: {
            imageCount: 0,
            rowCount: 1,
            targetSheetId: "sheet-1",
          },
        }),
        expect.objectContaining({
          outcome: "SUCCESS",
          responseMetadata: {
            imageCount: 0,
            rowCount: 1,
            targetSheetId: "sheet-1",
          },
        }),
      ]),
    );
  });

  test("records permanent permission failures without leaking secrets", async () => {
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
        async createFilter() {},
        async readRange() {
          throw new FeishuApiError(
            "1310213",
            "椋炰功鏂囨。鏉冮檺涓嶈冻锛岃灏嗗簲鐢ㄦ坊鍔犱负鐭ヨ瘑搴撴垨鐢靛瓙琛ㄦ牸鍗忎綔鑰?",
            false,
          );
        },
        async setRangeStyle() {},
        async updateDimension() {},
        async updateSheetProperties() {},
        async writeImage() {},
        async writeRange() {},
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      now,
      sourceClient: {
        async resolveWikiSpreadsheet() {
          return { spreadsheetToken: "spreadsheet-source" };
        },
      },
    });

    expect(result).toEqual({ botCompleted: 0, cargoCompleted: 0, failed: 1 });
    const [event] = await db.select().from(integrationOutbox);
    expect(event).toMatchObject({
      attemptCount: 1,
      lastErrorCode: "1310213",
      lastErrorMessage:
        "椋炰功鏂囨。鏉冮檺涓嶈冻锛岃灏嗗簲鐢ㄦ坊鍔犱负鐭ヨ瘑搴撴垨鐢靛瓙琛ㄦ牸鍗忎綔鑰?",
      status: "FAILED",
    });
    expect(event.nextAttemptAt.toISOString()).toBe("9999-12-31T23:59:59.999Z");
    expect(await db.select().from(integrationAttempts)).toEqual([
      expect.objectContaining({ outcome: "PERMANENT_FAILURE" }),
    ]);
  });

  test("marks source and target collisions as permanent before any target write", async () => {
    setFeishuWriterEnv();
    const now = new Date("2026-08-12T06:05:00.000Z");
    await db.transaction((tx) =>
      enqueueCargoSyncEvent(tx, {
        idempotencyKey: "source-target-collision",
        now,
        reason: "source-target-collision",
      }),
    );

    let targetWriteCalls = 0;
    const result = await processFeishuOutbox({
      botClient: { async sendTextMessage() {} },
      cargoClient: {
        async createFilter() {
          targetWriteCalls += 1;
        },
        async readRange() {
          targetWriteCalls += 1;
          return [];
        },
        async setRangeStyle() {
          targetWriteCalls += 1;
        },
        async updateDimension() {
          targetWriteCalls += 1;
        },
        async updateSheetProperties() {
          targetWriteCalls += 1;
        },
        async writeImage() {
          targetWriteCalls += 1;
        },
        async writeRange() {
          targetWriteCalls += 1;
        },
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      now,
      sourceClient: {
        async resolveWikiSpreadsheet() {
          return { spreadsheetToken: "spreadsheet-target" };
        },
      },
    });

    expect(result).toEqual({ botCompleted: 0, cargoCompleted: 0, failed: 1 });
    expect(targetWriteCalls).toBe(0);
    expect(await db.select().from(integrationAttempts)).toEqual([
      expect.objectContaining({ outcome: "PERMANENT_FAILURE" }),
    ]);
  });

  test("retries transient cargo failures with exponential backoff and succeeds on the next eligible poll", async () => {
    setFeishuWriterEnv();
    const now = new Date("2026-08-12T06:30:00.000Z");
    await enqueueFeishuCargoSync({ now, reason: "transient-failure" });
    let fail = true;

    const baseInput = {
      botClient: { async sendTextMessage() {} },
      cargoClient: {
        async createFilter() {},
        async readRange() {
          if (fail) {
            throw new FeishuApiError("HTTP_503", "飞书接口网络响应异常（503）", true);
          }
          return [];
        },
        async setRangeStyle() {},
        async updateDimension() {},
        async updateSheetProperties() {},
        async writeImage() {},
        async writeRange() {},
      },
      config: {
        sourceWikiToken: "wiki-1",
        internalChatId: "chat-1",
        targetSheetId: "sheet-1",
        targetSpreadsheetToken: "spreadsheet-target",
      },
      sourceClient: {
        async resolveWikiSpreadsheet() {
          return { spreadsheetToken: "spreadsheet-source" };
        },
      },
    };

    await expect(processFeishuOutbox({ ...baseInput, now })).resolves.toMatchObject({
      failed: 1,
    });

    const [failedEvent] = await db.select().from(integrationOutbox);
    expect(failedEvent).toMatchObject({ attemptCount: 1, status: "FAILED" });
    expect(failedEvent.nextAttemptAt.toISOString()).toBe("2026-08-12T06:35:00.000Z");

    fail = false;
    await expect(
      processFeishuOutbox({
        ...baseInput,
        now: new Date("2026-08-12T06:34:59.000Z"),
      }),
    ).resolves.toMatchObject({ cargoCompleted: 0, failed: 0 });
    await expect(
      processFeishuOutbox({
        ...baseInput,
        now: new Date("2026-08-12T06:35:00.000Z"),
      }),
    ).resolves.toMatchObject({ cargoCompleted: 1, failed: 0 });

    expect(await db.select().from(integrationOutbox)).toEqual([
      expect.objectContaining({ attemptCount: 2, status: "COMPLETED" }),
    ]);
    expect(
      (await db.select().from(integrationAttempts)).map((attempt) => attempt.outcome),
    ).toEqual(["RETRYABLE_FAILURE", "SUCCESS"]);
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

  test("rejects partial target configuration instead of silently skipping cargo enqueue", async () => {
    setFeishuPartialTargetEnv();
    const now = new Date("2026-08-12T07:05:00.000Z");

    await expect(
      db.transaction((tx) =>
        enqueueCargoSyncEvent(tx, {
          idempotencyKey: "partial-target-transaction",
          now,
          reason: "partial-target",
        }),
      ),
    ).rejects.toThrowError("飞书集成配置不完整，请检查服务端环境变量");

    await expect(
      enqueueFeishuCargoSync({ now, reason: "partial-target" }),
    ).rejects.toThrowError("飞书集成配置不完整，请检查服务端环境变量");

    expect(await db.select().from(integrationOutbox)).toHaveLength(0);
    expect(await db.select().from(integrationAttempts)).toHaveLength(0);
  });
});
