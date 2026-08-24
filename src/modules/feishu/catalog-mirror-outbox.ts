import { randomUUID } from "node:crypto";

import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import { integrationAttempts, integrationOutbox } from "@/db/schema";
import { createSystemNotification } from "@/modules/notifications/service";

export const FEISHU_CATALOG_MIRROR_EVENT = "FEISHU_CATALOG_MIRROR";
const MIRROR_LEASE_MS = 15 * 60_000;
const MIRROR_MAX_ATTEMPTS = 8;
const NEVER_RETRY_AT = new Date("9999-12-31T23:59:59.999Z");
const STALE_PROCESSING_EXHAUSTED_CODE = "RETRY_EXHAUSTED:STALE_PROCESSING";
const STALE_PROCESSING_EXHAUSTED_MESSAGE =
  "飞书货盘同步第八次处理的租约已过期，已停止自动重试，需要人工核查";

type CatalogMirrorResult = {
  archivedSkuCount: number;
  createdProductCount: number;
  createdSkuCount: number;
  degradedSkuCount: number;
  inventoryAdjustedSkuCount: number;
  matchedSkuCount: number;
  skuCount: number;
};

type ClaimedMirror = {
  actorUserId: string;
  attemptNumber: number;
  claimToken: string;
  eventId: string;
  payload: Record<string, unknown>;
  sourceSheetId: string;
};

const PERMANENT_FAILURES = new Map<string, string>([
  ["NO_SYNCABLE_SKUS", "飞书货盘中没有可同步的有效 SKU，本次未修改系统数据"],
  ["PARSER_BLOCKING_ISSUES", "飞书货盘存在阻断问题，本次未修改系统数据"],
  ["PRODUCT_GROUPING_CONFLICT", "飞书商品分组与系统归属冲突，本次未修改系统数据"],
  ["SOURCE_SYNC_SUPERSEDED", "本次同步已被更新的同步任务取代"],
]);

function safeFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const permanentMessage = PERMANENT_FAILURES.get(code);
  if (permanentMessage) return { code, message: permanentMessage, retryable: false };
  switch (code) {
    case "MIRROR_ACTIVE_RESERVATIONS":
      return {
        code,
        message: "系统存在活动库存占用，货盘同步将在稍后重试",
        retryable: true,
      };
    case "SOURCE_CHANGED_DURING_SYNC":
      return {
        code,
        message: "飞书货盘在同步期间发生变化，系统将在稍后重试",
        retryable: true,
      };
    case "SOURCE_IMAGE_DOWNLOAD_FAILED":
      return {
        code,
        message: "读取飞书货盘图片失败，系统将在稍后重试",
        retryable: true,
      };
    default:
      return {
        code: "FEISHU_CATALOG_MIRROR_FAILED",
        message: "飞书货盘同步暂时失败，系统将在稍后重试",
        retryable: true,
      };
  }
}

function retryAt(now: Date, attemptNumber: number) {
  const delayMs = Math.min(6 * 60 * 60_000, 60_000 * 2 ** (attemptNumber - 1));
  return new Date(now.getTime() + delayMs);
}

async function createDeadLetterNotification(
  tx: DbTransaction,
  input: { errorCode: string; eventId: string; now: Date },
) {
  await createSystemNotification(tx, {
    deduplicationKey: `feishu-catalog-mirror-dead-letter:${input.eventId}`,
    delivery: "IN_APP_ONLY",
    entityId: input.eventId,
    entityType: "INTEGRATION_OUTBOX",
    message: `飞书货盘同步已停止自动重试（${input.errorCode}），请检查飞书货盘与连接配置后重新发起。`,
    now: input.now,
    severity: "ERROR",
    title: "飞书货盘同步进入死信",
    type: "FEISHU_CATALOG_MIRROR_DEAD_LETTER",
  });
}

function readMirrorPayload(payload: Record<string, unknown>) {
  const actorUserId = typeof payload.actorUserId === "string" ? payload.actorUserId : "";
  const sourceSheetId = typeof payload.sourceSheetId === "string" ? payload.sourceSheetId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorUserId)) {
    throw new Error("INVALID_MIRROR_PAYLOAD");
  }
  if (!sourceSheetId || sourceSheetId.length > 100) {
    throw new Error("INVALID_MIRROR_PAYLOAD");
  }
  return { actorUserId, sourceSheetId };
}

async function claimCatalogMirror(now: Date): Promise<{
  event: ClaimedMirror | null;
  permanentlyFailed: number;
}> {
  const staleCutoff = new Date(now.getTime() - MIRROR_LEASE_MS);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      attemptNumber: number;
      eventId: string;
      lockedAt: Date | string | null;
      payload: Record<string, unknown>;
      status: "FAILED" | "PENDING" | "PROCESSING";
    }>(sql`
      select
        id as "eventId",
        attempt_count as "attemptNumber",
        locked_at as "lockedAt",
        payload,
        status
      from integration_outbox
      where event_type = ${FEISHU_CATALOG_MIRROR_EVENT}
        and target = 'FEISHU_SHEET'
        and (
          (status in ('PENDING', 'FAILED') and next_attempt_at <= ${now.toISOString()}::timestamptz)
          or (status = 'PROCESSING' and (locked_at is null or locked_at <= ${staleCutoff.toISOString()}::timestamptz))
        )
      order by next_attempt_at, id
      for update skip locked
      limit 1
    `);
    const row = rows[0];
    if (!row) return { event: null, permanentlyFailed: 0 };

    const lockedAt =
      row.lockedAt instanceof Date
        ? row.lockedAt
        : row.lockedAt
          ? new Date(row.lockedAt)
          : now;
    if (
      row.status === "PROCESSING" &&
      row.attemptNumber >= MIRROR_MAX_ATTEMPTS
    ) {
      await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          lastErrorCode: STALE_PROCESSING_EXHAUSTED_CODE,
          lastErrorMessage: STALE_PROCESSING_EXHAUSTED_MESSAGE,
          lockedAt: null,
          nextAttemptAt: NEVER_RETRY_AT,
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, row.eventId));
      await tx.insert(integrationAttempts).values({
        attemptNumber: row.attemptNumber,
        errorCode: STALE_PROCESSING_EXHAUSTED_CODE,
        errorMessage: STALE_PROCESSING_EXHAUSTED_MESSAGE,
        finishedAt: now,
        outcome: "PERMANENT_FAILURE",
        outboxEventId: row.eventId,
        startedAt: lockedAt,
      });
      await createDeadLetterNotification(tx, {
        errorCode: STALE_PROCESSING_EXHAUSTED_CODE,
        eventId: row.eventId,
        now,
      });
      return { event: null, permanentlyFailed: 1 };
    }

    if (row.status === "PROCESSING" && row.attemptNumber > 0) {
      await tx.insert(integrationAttempts).values({
        attemptNumber: row.attemptNumber,
        errorCode: "STALE_PROCESSING",
        errorMessage: "Catalog mirror processing lease expired before completion",
        finishedAt: now,
        outcome: "RETRYABLE_FAILURE",
        outboxEventId: row.eventId,
        startedAt: lockedAt,
      });
    }

    let actorUserId: string;
    let sourceSheetId: string;
    try {
      ({ actorUserId, sourceSheetId } = readMirrorPayload(row.payload));
    } catch {
      const attemptNumber = row.attemptNumber + 1;
      await tx
        .update(integrationOutbox)
        .set({
          attemptCount: attemptNumber,
          claimToken: null,
          lastErrorCode: "INVALID_MIRROR_PAYLOAD",
          lastErrorMessage: "飞书货盘同步任务数据无效，需要人工重新发起",
          lockedAt: null,
          nextAttemptAt: NEVER_RETRY_AT,
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, row.eventId));
      await tx.insert(integrationAttempts).values({
        attemptNumber,
        errorCode: "INVALID_MIRROR_PAYLOAD",
        errorMessage: "飞书货盘同步任务数据无效，需要人工重新发起",
        finishedAt: now,
        outcome: "PERMANENT_FAILURE",
        outboxEventId: row.eventId,
        startedAt: now,
      });
      await createDeadLetterNotification(tx, {
        errorCode: "INVALID_MIRROR_PAYLOAD",
        eventId: row.eventId,
        now,
      });
      return { event: null, permanentlyFailed: 1 };
    }

    const claimToken = randomUUID();
    const attemptNumber = row.attemptNumber + 1;
    await tx
      .update(integrationOutbox)
      .set({
        attemptCount: attemptNumber,
        claimToken,
        lockedAt: now,
        status: "PROCESSING",
        updatedAt: now,
      })
      .where(eq(integrationOutbox.id, row.eventId));
    return {
      event: {
        actorUserId,
        attemptNumber,
        claimToken,
        eventId: row.eventId,
        payload: row.payload,
        sourceSheetId,
      },
      permanentlyFailed: 0,
    };
  });
}

export async function enqueueCatalogMirror(input: {
  actorUserId: string;
  now?: Date;
  sourceSheetId: string;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('feishu-catalog-mirror-enqueue'))`,
    );

    const [existing] = await tx
      .select({ id: integrationOutbox.id })
      .from(integrationOutbox)
      .where(
        and(
          eq(integrationOutbox.eventType, FEISHU_CATALOG_MIRROR_EVENT),
          or(
            inArray(integrationOutbox.status, ["PENDING", "PROCESSING"]),
            and(
              eq(integrationOutbox.status, "FAILED"),
              lt(integrationOutbox.nextAttemptAt, NEVER_RETRY_AT),
            ),
          ),
        ),
      )
      .limit(1);
    if (existing) return { created: false, eventId: existing.id };

    const [created] = await tx
      .insert(integrationOutbox)
      .values({
        aggregateId: "catalog-mirror",
        aggregateType: "CATALOG_MIRROR",
        eventType: FEISHU_CATALOG_MIRROR_EVENT,
        idempotencyKey: `feishu:catalog-mirror:${randomUUID()}`,
        nextAttemptAt: now,
        payload: {
          actorUserId: input.actorUserId,
          sourceSheetId: input.sourceSheetId,
        },
        target: "FEISHU_SHEET",
      })
      .returning({ id: integrationOutbox.id });

    if (!created) throw new Error("CATALOG_MIRROR_ENQUEUE_FAILED");
    return { created: true, eventId: created.id };
  });
}

export async function processCatalogMirrorOutbox(input: {
  apply: (job: {
    actorUserId: string;
    sourceSheetId: string;
  }) => Promise<CatalogMirrorResult>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claimed = await claimCatalogMirror(now);
  const event = claimed.event;
  if (!event) {
    return {
      completed: 0,
      failed: claimed.permanentlyFailed,
      processed: claimed.permanentlyFailed,
    };
  }

  try {
    const result = await input.apply({
      actorUserId: event.actorUserId,
      sourceSheetId: event.sourceSheetId,
    });
    const completed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          completedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          lockedAt: null,
          payload: { ...event.payload, result },
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationOutbox.id, event.eventId),
            eq(integrationOutbox.claimToken, event.claimToken),
            eq(integrationOutbox.status, "PROCESSING"),
          ),
        )
        .returning({ id: integrationOutbox.id });
      if (!updated) return 0;
      await tx.insert(integrationAttempts).values({
        attemptNumber: event.attemptNumber,
        finishedAt: now,
        outcome: "SUCCESS",
        outboxEventId: event.eventId,
        responseMetadata: result,
        startedAt: now,
      });
      return 1;
    });
    return { completed, failed: 0, processed: 1 };
  } catch (error) {
    const failure = safeFailure(error);
    const exhausted =
      failure.retryable && event.attemptNumber >= MIRROR_MAX_ATTEMPTS;
    const permanent = !failure.retryable || exhausted;
    const code = exhausted
      ? `RETRY_EXHAUSTED:${failure.code}`.slice(0, 80)
      : failure.code.slice(0, 80);
    const message = exhausted
      ? "飞书货盘同步连续重试仍失败，已停止自动重试"
      : failure.message;
    const failed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          lastErrorCode: code,
          lastErrorMessage: message,
          lockedAt: null,
          nextAttemptAt: permanent
            ? NEVER_RETRY_AT
            : retryAt(now, event.attemptNumber),
          status: "FAILED",
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationOutbox.id, event.eventId),
            eq(integrationOutbox.claimToken, event.claimToken),
            eq(integrationOutbox.status, "PROCESSING"),
          ),
        )
        .returning({ id: integrationOutbox.id });
      if (!updated) return 0;
      await tx.insert(integrationAttempts).values({
        attemptNumber: event.attemptNumber,
        errorCode: code,
        errorMessage: message,
        finishedAt: now,
        outcome: permanent ? "PERMANENT_FAILURE" : "RETRYABLE_FAILURE",
        outboxEventId: event.eventId,
        startedAt: now,
      });
      if (permanent) {
        await createDeadLetterNotification(tx, {
          errorCode: code,
          eventId: event.eventId,
          now,
        });
      }
      return 1;
    });
    return { completed: 0, failed, processed: 1 };
  }
}
