import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbTransaction } from "@/db/client";
import { integrationAttempts, integrationOutbox } from "@/db/schema";
import { FeishuApiError } from "@/integrations/feishu/client";
import {
  canProcessFeishuBot,
  canWriteFeishuCargo,
  hasFeishuRuntimeConfiguration,
  readFeishuConfig,
  type FeishuIntegrationConfig,
} from "@/integrations/feishu/config";

import {
  FeishuCargoSyncError,
  syncCargoSnapshot,
  type FeishuCargoTargetPort,
} from "./cargo-sync";

export type FeishuBotPort = {
  sendTextMessage(input: { chatId: string; text: string }): Promise<unknown>;
};

type FeishuWorkerConfig = Pick<
  FeishuIntegrationConfig,
  | "cargoWritesEnabled"
  | "internalChatId"
  | "sourceWikiToken"
  | "targetSheetId"
  | "targetSpreadsheetToken"
>;

type FeishuSourceResolverPort = {
  resolveWikiSpreadsheet(
    wikiToken: string,
  ): Promise<{ spreadsheetToken: string }>;
};

const NEVER_RETRY_AT = new Date("9999-12-31T23:59:59.999Z");
const OUTBOX_LEASE_MS = 15 * 60_000;

type ClaimedEvent = {
  attemptNumber: number;
  claimToken: string;
  id: string;
  payload: Record<string, unknown>;
};

function isCargoWriterEnabledInEnvironment(
  environment: Record<string, string | undefined> = process.env,
) {
  if (!hasFeishuRuntimeConfiguration(environment)) {
    return false;
  }
  return canWriteFeishuCargo(readFeishuConfig(environment));
}

export async function enqueueCargoSyncEvent(
  tx: DbTransaction,
  input: { idempotencyKey: string; now?: Date; reason: string },
) {
  if (!isCargoWriterEnabledInEnvironment()) return;
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
  if (!isCargoWriterEnabledInEnvironment()) return false;
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
  if (error instanceof FeishuCargoSyncError) {
    return {
      code: error.code.slice(0, 80),
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  if (error instanceof FeishuApiError) {
    return {
      code: error.code.slice(0, 80),
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  return {
    code: "FEISHU_SYNC_FAILED",
    message: "飞书同步任务失败",
    retryable: true,
  };
}

function retryAt(now: Date, attemptNumber: number) {
  const clampedAttempt = Math.max(1, attemptNumber);
  const delayMs = Math.min(
    6 * 60 * 60_000,
    5 * 60_000 * 2 ** (clampedAttempt - 1),
  );
  return new Date(now.getTime() + delayMs);
}

async function markEventsCompleted(
  events: ClaimedEvent[],
  now: Date,
  responseMetadata: Record<string, unknown>,
) {
  if (events.length === 0) return 0;
  return db.transaction(async (tx) => {
    const completed: ClaimedEvent[] = [];
    for (const event of events) {
      const [updated] = await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          completedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          lockedAt: null,
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationOutbox.id, event.id),
            eq(integrationOutbox.claimToken, event.claimToken),
            eq(integrationOutbox.status, "PROCESSING"),
          ),
        )
        .returning({ id: integrationOutbox.id });
      if (updated) completed.push(event);
    }
    if (completed.length > 0) {
      await tx.insert(integrationAttempts).values(
        completed.map((event) => ({
          attemptNumber: event.attemptNumber,
          finishedAt: now,
          outcome: "SUCCESS" as const,
          outboxEventId: event.id,
          responseMetadata,
          startedAt: now,
        })),
      );
    }
    return completed.length;
  });
}

async function markEventsFailed(
  events: ClaimedEvent[],
  error: unknown,
  now: Date,
) {
  if (events.length === 0) return 0;
  const failure = safeError(error);
  return db.transaction(async (tx) => {
    const failed: ClaimedEvent[] = [];
    for (const event of events) {
      const [updated] = await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          lockedAt: null,
          nextAttemptAt: failure.retryable
            ? retryAt(now, event.attemptNumber)
            : NEVER_RETRY_AT,
          status: "FAILED",
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationOutbox.id, event.id),
            eq(integrationOutbox.claimToken, event.claimToken),
            eq(integrationOutbox.status, "PROCESSING"),
          ),
        )
        .returning({ id: integrationOutbox.id });
      if (updated) failed.push(event);
    }
    if (failed.length > 0) {
      await tx.insert(integrationAttempts).values(
        failed.map((event) => ({
          attemptNumber: event.attemptNumber,
          errorCode: failure.code,
          errorMessage: failure.message,
          finishedAt: now,
          outcome: failure.retryable
            ? ("RETRYABLE_FAILURE" as const)
            : ("PERMANENT_FAILURE" as const),
          outboxEventId: event.id,
          startedAt: now,
        })),
      );
    }
    return failed.length;
  });
}

async function claimEvents(target: "FEISHU_SHEET" | "FEISHU_BOT", now: Date) {
  const staleLeaseCutoff = new Date(now.getTime() - OUTBOX_LEASE_MS);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      attemptCount: number;
      id: string;
      lockedAt: Date | string | null;
      payload: Record<string, unknown>;
      status: string;
    }>(sql`
      select
        id,
        attempt_count as "attemptCount",
        locked_at as "lockedAt",
        payload,
        status
      from integration_outbox
      where target = ${target}
        and (
          (
            status in ('PENDING', 'FAILED')
            and next_attempt_at <= ${now.toISOString()}::timestamptz
          )
          or (
            status = 'PROCESSING'
            and (
              locked_at is null
              or locked_at <= ${staleLeaseCutoff.toISOString()}::timestamptz
            )
          )
        )
      order by next_attempt_at, id
      for update skip locked
      limit 200
    `);
    const claimed: ClaimedEvent[] = [];
    for (const row of rows) {
      const claimToken = crypto.randomUUID();
      if (row.status === "PROCESSING" && row.attemptCount > 0) {
        await tx.insert(integrationAttempts).values({
          attemptNumber: row.attemptCount,
          errorCode: "STALE_PROCESSING",
          errorMessage: "Outbox processing lease expired before completion",
          finishedAt: now,
          outcome: "RETRYABLE_FAILURE",
          outboxEventId: row.id,
          startedAt: row.lockedAt ? new Date(row.lockedAt) : now,
        });
      }
      await tx
        .update(integrationOutbox)
        .set({
          attemptCount: row.attemptCount + 1,
          claimToken,
          lockedAt: now,
          status: "PROCESSING",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, row.id));
      claimed.push({
        attemptNumber: row.attemptCount + 1,
        claimToken,
        id: row.id,
        payload: row.payload,
      });
    }
    return claimed;
  });
}

export async function processFeishuOutbox(input: {
  botClient: FeishuBotPort;
  cargoClient: FeishuCargoTargetPort;
  config: FeishuWorkerConfig;
  now?: Date;
  sourceClient?: FeishuSourceResolverPort;
}) {
  const now = input.now ?? new Date();
  const summary = { botCompleted: 0, cargoCompleted: 0, failed: 0 };
  const sourceClient =
    input.sourceClient ??
    (input.cargoClient as FeishuCargoTargetPort & FeishuSourceResolverPort);

  if (canWriteFeishuCargo(input.config)) {
    const cargoEvents = await claimEvents("FEISHU_SHEET", now);
    if (cargoEvents.length > 0) {
      try {
        const { spreadsheetToken: sourceSpreadsheetToken } =
          await sourceClient.resolveWikiSpreadsheet(
            input.config.sourceWikiToken,
          );
        const result = await syncCargoSnapshot({
          client: input.cargoClient,
          config: {
            sourceSpreadsheetToken,
            targetSheetId: input.config.targetSheetId!,
            targetSpreadsheetToken: input.config.targetSpreadsheetToken!,
          },
        });
        summary.cargoCompleted = await markEventsCompleted(cargoEvents, now, {
          imageCount: result.imageCount,
          rowCount: result.rowCount,
          targetSheetId: result.targetSheetId,
        });
      } catch (error) {
        summary.failed += await markEventsFailed(cargoEvents, error, now);
      }
    }
  }

  if (canProcessFeishuBot(input.config)) {
    const botEvents = await claimEvents("FEISHU_BOT", now);
    for (const event of botEvents) {
      const title = String(event.payload.title ?? "系统通知");
      const message = String(event.payload.message ?? "请登录系统查看详情");
      try {
        await input.botClient.sendTextMessage({
          chatId: input.config.internalChatId!,
          text: `【同舟行跨境】${title}\n${message}`,
        });
        summary.botCompleted += await markEventsCompleted([event], now, {});
      } catch (error) {
        summary.failed += await markEventsFailed([event], error, now);
      }
    }
  }
  return summary;
}
