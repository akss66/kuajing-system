import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  integrationAttempts,
  integrationOutbox,
  systemNotifications,
} from "@/db/schema";
import {
  enqueueCatalogMirror,
  FEISHU_CATALOG_MIRROR_EVENT,
  processCatalogMirrorOutbox,
} from "@/modules/feishu/catalog-mirror-outbox";
import {
  getLatestCargoTargetSyncState,
  getLatestCatalogMirrorTaskState,
} from "@/modules/feishu/queries";

describe("Feishu catalog mirror outbox", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        integration_attempts,
        system_notifications,
        integration_outbox
      restart identity cascade
    `));
  });

  test("durably queues one active mirror and completes it through the worker", async () => {
    const now = new Date("2026-08-24T02:00:00.000Z");
    const first = await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      now,
      sourceSheetId: "sheet-source-a",
    });
    const duplicate = await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      now,
      sourceSheetId: "sheet-source-a",
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ created: false, eventId: first.eventId });
    await expect(getLatestCatalogMirrorTaskState()).resolves.toMatchObject({
      isActive: true,
      statusLabel: "排队中",
      tone: "default",
    });

    const apply = vi.fn().mockResolvedValue({
      archivedSkuCount: 2,
      createdProductCount: 1,
      createdSkuCount: 3,
      degradedSkuCount: 4,
      inventoryAdjustedSkuCount: 5,
      matchedSkuCount: 130,
      skuCount: 133,
    });
    await expect(processCatalogMirrorOutbox({ apply, now })).resolves.toEqual({
      completed: 1,
      failed: 0,
      processed: 1,
    });

    expect(apply).toHaveBeenCalledWith({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      sourceSheetId: "sheet-source-a",
    });
    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, first.eventId));
    expect(event).toMatchObject({
      claimToken: null,
      completedAt: now,
      eventType: FEISHU_CATALOG_MIRROR_EVENT,
      lastErrorCode: null,
      status: "COMPLETED",
    });
    expect(event.payload).toMatchObject({
      result: {
        archivedSkuCount: 2,
        createdProductCount: 1,
        createdSkuCount: 3,
        degradedSkuCount: 4,
        inventoryAdjustedSkuCount: 5,
        matchedSkuCount: 130,
        skuCount: 133,
      },
    });
    await expect(
      db
        .select()
        .from(integrationAttempts)
        .where(eq(integrationAttempts.outboxEventId, first.eventId)),
    ).resolves.toMatchObject([
      {
        attemptNumber: 1,
        errorCode: null,
        outcome: "SUCCESS",
      },
    ]);
    await expect(getLatestCatalogMirrorTaskState()).resolves.toMatchObject({
      isActive: false,
      result: { skuCount: 133 },
      statusLabel: "同步完成",
      tone: "success",
    });
  });

  test("keeps retryable failures single-flight and exposes only a safe status", async () => {
    const now = new Date("2026-08-24T03:00:00.000Z");
    const queued = await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000002",
      now,
      sourceSheetId: "sheet-source-a",
    });

    await expect(
      processCatalogMirrorOutbox({
        apply: vi.fn().mockRejectedValue(
          new Error("SOURCE_IMAGE_DOWNLOAD_FAILED"),
        ),
        now,
      }),
    ).resolves.toEqual({ completed: 0, failed: 1, processed: 1 });

    await expect(getLatestCatalogMirrorTaskState()).resolves.toMatchObject({
      isActive: true,
      safeErrorMessage: "读取飞书货盘图片失败，后台稍后会自动重试。",
      statusLabel: "等待重试",
    });
    await expect(
      enqueueCatalogMirror({
        actorUserId: "00000000-0000-4000-8000-000000000002",
        now,
        sourceSheetId: "sheet-source-a",
      }),
    ).resolves.toEqual({ created: false, eventId: queued.eventId });

    const retryNow = new Date(now.getTime() + 2 * 60_000);
    await expect(
      processCatalogMirrorOutbox({
        apply: vi.fn().mockResolvedValue({
          archivedSkuCount: 0,
          createdProductCount: 0,
          createdSkuCount: 0,
          degradedSkuCount: 0,
          inventoryAdjustedSkuCount: 0,
          matchedSkuCount: 140,
          skuCount: 140,
        }),
        now: retryNow,
      }),
    ).resolves.toMatchObject({ completed: 1, processed: 1 });
  });

  test("parks parser failures permanently without exposing raw source details", async () => {
    const now = new Date("2026-08-24T04:00:00.000Z");
    await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000003",
      now,
      sourceSheetId: "sheet-secret-source",
    });
    await processCatalogMirrorOutbox({
      apply: vi.fn().mockRejectedValue(new Error("PARSER_BLOCKING_ISSUES")),
      now,
    });

    const state = await getLatestCatalogMirrorTaskState();
    expect(state).toMatchObject({
      isActive: false,
      safeErrorMessage: "飞书货盘存在阻断问题，请修正后重新同步。",
      statusLabel: "需要处理",
      tone: "danger",
    });
    expect(JSON.stringify(state)).not.toContain("sheet-secret-source");
  });

  test("records an expired lease before reclaiming and completing the next attempt", async () => {
    const firstStartedAt = new Date("2026-08-24T05:00:00.000Z");
    const retryNow = new Date("2026-08-24T05:16:00.000Z");
    const queued = await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000004",
      now: firstStartedAt,
      sourceSheetId: "sheet-source-a",
    });
    await db
      .update(integrationOutbox)
      .set({
        attemptCount: 1,
        claimToken: "00000000-0000-4000-8000-000000000099",
        lockedAt: firstStartedAt,
        status: "PROCESSING",
      })
      .where(eq(integrationOutbox.id, queued.eventId));

    await expect(
      processCatalogMirrorOutbox({
        apply: vi.fn().mockResolvedValue({
          archivedSkuCount: 0,
          createdProductCount: 0,
          createdSkuCount: 0,
          degradedSkuCount: 0,
          inventoryAdjustedSkuCount: 0,
          matchedSkuCount: 140,
          skuCount: 140,
        }),
        now: retryNow,
      }),
    ).resolves.toEqual({ completed: 1, failed: 0, processed: 1 });

    await expect(
      db
        .select()
        .from(integrationAttempts)
        .where(eq(integrationAttempts.outboxEventId, queued.eventId)),
    ).resolves.toMatchObject([
      {
        attemptNumber: 1,
        errorCode: "STALE_PROCESSING",
        outcome: "RETRYABLE_FAILURE",
        startedAt: firstStartedAt,
      },
      { attemptNumber: 2, outcome: "SUCCESS" },
    ]);
  });

  test("dead-letters an exhausted expired lease without running the mirror again", async () => {
    const firstStartedAt = new Date("2026-08-24T06:00:00.000Z");
    const retryNow = new Date("2026-08-24T06:16:00.000Z");
    const queued = await enqueueCatalogMirror({
      actorUserId: "00000000-0000-4000-8000-000000000005",
      now: firstStartedAt,
      sourceSheetId: "sheet-source-a",
    });
    await db
      .update(integrationOutbox)
      .set({
        attemptCount: 8,
        claimToken: "00000000-0000-4000-8000-000000000098",
        lockedAt: firstStartedAt,
        status: "PROCESSING",
      })
      .where(eq(integrationOutbox.id, queued.eventId));
    const apply = vi.fn();

    await expect(
      processCatalogMirrorOutbox({ apply, now: retryNow }),
    ).resolves.toEqual({ completed: 0, failed: 1, processed: 1 });
    expect(apply).not.toHaveBeenCalled();

    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, queued.eventId));
    expect(event).toMatchObject({
      attemptCount: 8,
      claimToken: null,
      lastErrorCode: "RETRY_EXHAUSTED:STALE_PROCESSING",
      lockedAt: null,
      status: "FAILED",
    });
    expect(event.nextAttemptAt.getUTCFullYear()).toBe(9999);
    await expect(
      db
        .select()
        .from(integrationAttempts)
        .where(eq(integrationAttempts.outboxEventId, queued.eventId)),
    ).resolves.toMatchObject([
      {
        attemptNumber: 8,
        errorCode: "RETRY_EXHAUSTED:STALE_PROCESSING",
        outcome: "PERMANENT_FAILURE",
        startedAt: firstStartedAt,
      },
    ]);
    await expect(db.select().from(systemNotifications)).resolves.toMatchObject([
      {
        deduplicationKey: `feishu-catalog-mirror-dead-letter:${queued.eventId}`,
        entityId: queued.eventId,
        severity: "ERROR",
        status: "UNREAD",
        type: "FEISHU_CATALOG_MIRROR_DEAD_LETTER",
      },
    ]);
  });

  test("audits and dead-letters an invalid durable payload without invoking the provider", async () => {
    const now = new Date("2026-08-24T07:00:00.000Z");
    const queued = await enqueueCatalogMirror({
      actorUserId: "not-a-user-id",
      now,
      sourceSheetId: "sheet-source-a",
    });
    const apply = vi.fn();

    await expect(
      processCatalogMirrorOutbox({ apply, now }),
    ).resolves.toEqual({ completed: 0, failed: 1, processed: 1 });
    expect(apply).not.toHaveBeenCalled();

    const [event] = await db
      .select()
      .from(integrationOutbox)
      .where(eq(integrationOutbox.id, queued.eventId));
    expect(event).toMatchObject({
      attemptCount: 1,
      lastErrorCode: "INVALID_MIRROR_PAYLOAD",
      status: "FAILED",
    });
    await expect(
      db
        .select()
        .from(integrationAttempts)
        .where(eq(integrationAttempts.outboxEventId, queued.eventId)),
    ).resolves.toMatchObject([
      {
        attemptNumber: 1,
        errorCode: "INVALID_MIRROR_PAYLOAD",
        outcome: "PERMANENT_FAILURE",
      },
    ]);
    await expect(db.select().from(systemNotifications)).resolves.toHaveLength(1);
  });

  test("does not expose a raw target-sync provider error to the integration page", async () => {
    const now = new Date("2026-08-24T08:00:00.000Z");
    await db.insert(integrationOutbox).values({
      aggregateId: "cargo-sheet",
      aggregateType: "CARGO_SNAPSHOT",
      eventType: "FEISHU_CARGO_SYNC",
      idempotencyKey: "feishu:cargo:test-safe-error",
      lastErrorCode: "HTTP_503",
      lastErrorMessage:
        "request failed for app_secret=do-not-render and token=secret-token",
      nextAttemptAt: now,
      payload: {},
      status: "FAILED",
      target: "FEISHU_SHEET",
      updatedAt: now,
    });

    const state = await getLatestCargoTargetSyncState("target-sheet-a");
    expect(state).toMatchObject({
      canRetry: true,
      lastErrorMessage: "飞书目标表同步暂时失败，请稍后重试。",
      statusLabel: "等待重试",
    });
    expect(JSON.stringify(state)).not.toContain("do-not-render");
    expect(JSON.stringify(state)).not.toContain("secret-token");
  });
});
