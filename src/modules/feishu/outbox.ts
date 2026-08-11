import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbTransaction } from "@/db/client";
import {
  integrationAttempts,
  integrationOutbox,
} from "@/db/schema";
import { FeishuApiError } from "@/integrations/feishu/client";

import { syncCargoSnapshot, type FeishuCargoPort } from "./cargo-sync";

export type FeishuBotPort = {
  sendTextMessage(input: { chatId: string; text: string }): Promise<unknown>;
};

type FeishuWorkerConfig = {
  cargoSheetId?: string;
  cargoWikiToken: string;
  internalChatId: string;
};

export async function enqueueCargoSyncEvent(
  tx: DbTransaction,
  input: { idempotencyKey: string; now?: Date; reason: string },
) {
  const now = input.now ?? new Date();
  await tx
    .insert(integrationOutbox)
    .values({
      aggregateId: "cargo-sheet",
      aggregateType: "CARGO_SNAPSHOT",
      eventType: "FEISHU_CARGO_SYNC",
      idempotencyKey: `feishu:cargo:${input.idempotencyKey}`,
      nextAttemptAt: now,
      payload: { reason: input.reason },
      target: "FEISHU_SHEET",
    })
    .onConflictDoNothing();
}

export async function enqueueFeishuCargoSync(input?: {
  now?: Date;
  reason?: string;
}) {
  const now = input?.now ?? new Date();
  const fiveMinuteSlot = Math.floor(now.getTime() / (5 * 60_000));
  const [event] = await db
    .insert(integrationOutbox)
    .values({
      aggregateId: "cargo-sheet",
      aggregateType: "CARGO_SNAPSHOT",
      eventType: "FEISHU_CARGO_SYNC",
      idempotencyKey: `feishu:cargo:slot:${fiveMinuteSlot}`,
      nextAttemptAt: now,
      payload: { reason: input?.reason ?? "scheduled" },
      target: "FEISHU_SHEET",
    })
    .onConflictDoNothing()
    .returning({ id: integrationOutbox.id });
  return Boolean(event);
}

function safeError(error: unknown) {
  if (error instanceof FeishuApiError) {
    return {
      code: error.code.slice(0, 80),
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  return { code: "FEISHU_SYNC_FAILED", message: "飞书同步任务失败", retryable: true };
}

async function markEventsCompleted(
  ids: string[],
  attempts: Map<string, number>,
  now: Date,
  responseMetadata: Record<string, unknown>,
) {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(integrationOutbox)
      .set({
        completedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        lockedAt: null,
        status: "COMPLETED",
        updatedAt: now,
      })
      .where(inArray(integrationOutbox.id, ids));
    await tx.insert(integrationAttempts).values(
      ids.map((id) => ({
        attemptNumber: attempts.get(id)!,
        finishedAt: now,
        outcome: "SUCCESS" as const,
        outboxEventId: id,
        responseMetadata,
        startedAt: now,
      })),
    );
  });
}

async function markEventsFailed(
  ids: string[],
  attempts: Map<string, number>,
  error: unknown,
  now: Date,
) {
  if (ids.length === 0) return;
  const failure = safeError(error);
  const nextAttemptAt = new Date(now.getTime() + 5 * 60_000);
  await db.transaction(async (tx) => {
    await tx
      .update(integrationOutbox)
      .set({
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
        lockedAt: null,
        nextAttemptAt,
        status: "FAILED",
        updatedAt: now,
      })
      .where(inArray(integrationOutbox.id, ids));
    await tx.insert(integrationAttempts).values(
      ids.map((id) => ({
        attemptNumber: attempts.get(id)!,
        errorCode: failure.code,
        errorMessage: failure.message,
        finishedAt: now,
        outcome: failure.retryable
          ? ("RETRYABLE_FAILURE" as const)
          : ("PERMANENT_FAILURE" as const),
        outboxEventId: id,
        startedAt: now,
      })),
    );
  });
}

async function claimEvents(target: "FEISHU_SHEET" | "FEISHU_BOT", now: Date) {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      attemptCount: number;
      id: string;
      payload: Record<string, unknown>;
    }>(sql`
      select id, attempt_count as "attemptCount", payload
      from integration_outbox
      where target = ${target}
        and status in ('PENDING', 'FAILED')
        and next_attempt_at <= ${now.toISOString()}::timestamptz
      order by next_attempt_at, id
      for update skip locked
      limit 200
    `);
    for (const row of rows) {
      await tx
        .update(integrationOutbox)
        .set({
          attemptCount: row.attemptCount + 1,
          lockedAt: now,
          status: "PROCESSING",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, row.id));
    }
    return rows.map((row) => ({ ...row, attemptNumber: row.attemptCount + 1 }));
  });
}

export async function processFeishuOutbox(input: {
  botClient: FeishuBotPort;
  cargoClient: FeishuCargoPort;
  config: FeishuWorkerConfig;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const summary = { botCompleted: 0, cargoCompleted: 0, failed: 0 };

  const cargoEvents = await claimEvents("FEISHU_SHEET", now);
  if (cargoEvents.length > 0) {
    const ids = cargoEvents.map((event) => event.id);
    const attempts = new Map(
      cargoEvents.map((event) => [event.id, event.attemptNumber]),
    );
    try {
      const result = await syncCargoSnapshot({
        client: input.cargoClient,
        config: input.config,
      });
      await markEventsCompleted(ids, attempts, now, result);
      summary.cargoCompleted = ids.length;
    } catch (error) {
      await markEventsFailed(ids, attempts, error, now);
      summary.failed += ids.length;
    }
  }

  const botEvents = await claimEvents("FEISHU_BOT", now);
  for (const event of botEvents) {
    const attempts = new Map([[event.id, event.attemptNumber]]);
    const title = String(event.payload.title ?? "系统通知");
    const message = String(event.payload.message ?? "请登录系统查看详情");
    try {
      await input.botClient.sendTextMessage({
        chatId: input.config.internalChatId,
        text: `【同舟行跨境】${title}\n${message}`,
      });
      await markEventsCompleted([event.id], attempts, now, {});
      summary.botCompleted += 1;
    } catch (error) {
      await markEventsFailed([event.id], attempts, error, now);
      summary.failed += 1;
    }
  }
  return summary;
}
