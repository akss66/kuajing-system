import { eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  integrationAttempts,
  integrationOutbox,
  orderShipments,
  replacementRequests,
  shipmentFulfillments,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import type { JifengOrderDetail } from "@/integrations/jifeng/types";
import {
  createSystemNotification,
  resolveSystemNotificationsByDeduplicationPrefix,
} from "@/modules/notifications/service";

import { refreshParentFulfillmentStatus } from "./order-rollup";
import {
  applyJifengOrderStatus,
  isRemoteShippedInventoryInvariantFailure,
} from "./status-sync";

const LEGACY_MATCH_EVENT_TYPE = "JIFENG_CREATE_ORDER";
export const JIFENG_MATCH_LEASE_MS = 5 * 60 * 1000;
const NOT_FOUND_CODES = new Set(["50017", "50071"]);
const NEVER_RETRY_AT = new Date("9999-12-31T23:59:59.999Z");

export type JifengExistingOrderLookupPort = {
  getOrder(input: { platformOrderNo: string }): Promise<JifengOrderDetail>;
};

type MatchClaim = {
  attemptNumber: number;
  claimToken: string;
  fulfillmentId: string;
  orderId: string;
  platformOrderNo: string;
  shipmentId: string;
  startedAt: Date;
  isLocalCancelMonitoring: boolean;
};

type MatchFailure = {
  code: string;
  message: string;
  retryable: boolean;
  platformOrderNo?: string;
  remoteErpNo?: string;
  remoteOrderNo?: string;
  remoteStatus?: number;
};

class JifengOrderMatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JifengOrderMatchError";
  }
}

function retryAt(now: Date, attemptNumber: number) {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** (attemptNumber - 1));
  return new Date(now.getTime() + delayMs);
}

function matchFailure(error: unknown): MatchFailure {
  if (error instanceof JifengOrderMatchError) {
    return {
      code: error.code.slice(0, 80),
      message: error.message.slice(0, 500),
      retryable: false,
    };
  }
  if (error instanceof JifengApiError) {
    const notFound = NOT_FOUND_CODES.has(error.code);
    return {
      code: error.code.slice(0, 80),
      message: notFound
        ? "极风暂未找到对应的平台订单，系统将继续等待匹配"
        : error.message.slice(0, 500),
      retryable: notFound || error.retryable,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "极风已有订单匹配暂时失败",
    retryable: true,
  };
}

async function lockMatchRows(
  tx: DbTransaction,
  input: { eventId: string; fulfillmentId: string; orderId: string },
) {
  await tx.execute(sql`
    select id from fulfillment_orders where id = ${input.orderId} for update
  `);
  await tx.execute(sql`
    select id from shipment_fulfillments
    where id = ${input.fulfillmentId}
    for update
  `);
  await tx.execute(sql`
    select id from integration_outbox where id = ${input.eventId} for update
  `);
}

async function claimExistingOrderMatch(eventId: string, now: Date) {
  return db.transaction(async (tx) => {
    const references = await tx.execute<{ orderId: string }>(sql`
      select shipment.order_id as "orderId"
      from integration_outbox event
      inner join order_shipments shipment
        on shipment.id::text = event.aggregate_id
      where event.id = ${eventId}
        and event.target = 'JIFENG'
        and event.event_type = ${LEGACY_MATCH_EVENT_TYPE}
    `);
    const reference = references[0];
    if (!reference) throw new Error("未找到极风订单匹配任务");

    await tx.execute(sql`
      select id from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const rows = await tx.execute<{
      attemptCount: number;
      claimToken: string | null;
      eventStatus: string;
      eventLastErrorCode: string | null;
      fulfillmentId: string;
      fulfillmentStatus: string;
      lockedAt: Date | string | null;
      orderId: string;
      orderStatus: string;
      platformOrderNo: string;
      replacementRequestId: string | null;
      replacementStatus: string | null;
      shipmentId: string;
    }>(sql`
      select
        event.attempt_count as "attemptCount",
        event.claim_token as "claimToken",
        event.last_error_code as "eventLastErrorCode",
        event.status as "eventStatus",
        fulfillment.id as "fulfillmentId",
        fulfillment.status as "fulfillmentStatus",
        event.locked_at as "lockedAt",
        shipment.order_id as "orderId",
        parent.status as "orderStatus",
        shipment.external_order_no as "platformOrderNo",
        replacement.id as "replacementRequestId",
        replacement.status as "replacementStatus",
        shipment.id as "shipmentId"
      from integration_outbox event
      inner join shipment_fulfillments fulfillment
        on fulfillment.shipment_id::text = event.aggregate_id
      inner join order_shipments shipment on shipment.id = fulfillment.shipment_id
      inner join fulfillment_orders parent on parent.id = shipment.order_id
      left join replacement_requests replacement
        on replacement.replacement_shipment_id = shipment.id
      where event.id = ${eventId}
        and event.target = 'JIFENG'
        and event.event_type = ${LEGACY_MATCH_EVENT_TYPE}
      for update of event, fulfillment
    `);
    const row = rows[0];
    if (!row) throw new Error("未找到极风订单匹配任务");
    const normalizedPlatformOrderNo = row.platformOrderNo.trim();
    if (row.eventStatus === "COMPLETED") return "COMPLETED" as const;
    const isMonitoringCancelled =
      ["FAILED", "PENDING"].includes(row.eventStatus) &&
      row.eventLastErrorCode === "LOCAL_CANCEL_MONITORING";
    if (row.fulfillmentStatus === "CANCELLED") {
      if (!isMonitoringCancelled) {
        await tx
          .update(integrationOutbox)
          .set({
            claimToken: null,
            completedAt: now,
            lockedAt: null,
            status: "COMPLETED",
            updatedAt: now,
          })
          .where(eq(integrationOutbox.id, eventId));
        return "CANCELLED" as const;
      }
    } else if (row.fulfillmentStatus === "SHIPPED") {
      await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          completedAt: now,
          lockedAt: null,
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, eventId));
      return "COMPLETED" as const;
    }
    if (row.eventStatus === "PROCESSING") {
      const lockedAt = row.lockedAt instanceof Date
        ? row.lockedAt
        : row.lockedAt
          ? new Date(row.lockedAt)
          : null;
      if (lockedAt && lockedAt.getTime() + JIFENG_MATCH_LEASE_MS > now.getTime()) {
        return "BUSY" as const;
      }
      if (row.attemptCount > 0) {
        await tx.insert(integrationAttempts).values({
          attemptNumber: row.attemptCount,
          errorCode: "STALE_PROCESSING",
          errorMessage: "Jifeng order matching lease expired before completion",
          finishedAt: now,
          outcome: "RETRYABLE_FAILURE",
          outboxEventId: eventId,
          startedAt: lockedAt ?? now,
        });
      }
    }

    const replacementEligible =
      row.replacementRequestId !== null &&
      ["PENDING_FULFILLMENT", "EXCEPTION"].includes(row.replacementStatus ?? "");
    const normalEligible = [
      "PAID_PENDING_FULFILLMENT",
      "FULFILLING",
      "FULFILLMENT_EXCEPTION",
    ].includes(row.orderStatus);
    if (!normalEligible && !replacementEligible) {
      const cancelled = row.orderStatus === "CANCELLED";
      if (cancelled && isMonitoringCancelled) {
        // Local cancel monitoring mode: keep waiting for remote order reconciliation instead of closing out.
        // The event will be completed only after remote order is observed and bound.
      } else {
        await tx
          .update(integrationOutbox)
          .set({
            claimToken: null,
            completedAt: now,
            lastErrorCode: cancelled ? "ORDER_CANCELLED" : "ORDER_NOT_ELIGIBLE",
            lastErrorMessage: "Local order is not eligible for Jifeng matching",
            lockedAt: null,
            status: "COMPLETED",
            updatedAt: now,
          })
          .where(eq(integrationOutbox.id, eventId));
        return cancelled ? ("CANCELLED" as const) : ("NOT_ELIGIBLE" as const);
      }
    }

    const duplicatePlatformRows = await tx.execute<{ id: string }>(sql`
      select sf.id
      from shipment_fulfillments sf
      inner join order_shipments s on s.id = sf.shipment_id
      where s.external_order_no = ${normalizedPlatformOrderNo}
        and sf.status not in ('SHIPPED', 'CANCELLED')
        and s.id <> ${row.shipmentId}
      limit 1
    `);
    if (duplicatePlatformRows[0]) {
      if (isMonitoringCancelled) {
        await tx
          .update(integrationOutbox)
          .set({
            claimToken: null,
            completedAt: now,
            lastErrorCode: "LOCAL_CANCEL_MONITORING",
            lastErrorMessage:
              "Monitoring stopped because a re-imported active shipment now owns the same platform order number",
            lockedAt: null,
            status: "COMPLETED",
            updatedAt: now,
          })
          .where(eq(integrationOutbox.id, eventId));
        return "CANCELLED" as const;
      }
      await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          completedAt: null,
          lockedAt: null,
          lastErrorCode: "PLATFORM_ORDER_NO_NOT_GLOBAL_UNIQUE",
          lastErrorMessage:
            "平台订单号在系统内存在多个活跃包裹，无法安全匹配",
          nextAttemptAt: NEVER_RETRY_AT,
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, eventId));
      const failure: MatchFailure = {
        code: "PLATFORM_ORDER_NO_NOT_GLOBAL_UNIQUE",
        message:
          "平台订单号在系统内存在多个活跃包裹，无法安全匹配，请人工核查。",
        retryable: false,
        platformOrderNo: row.platformOrderNo,
      };
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          nextRetryAt: null,
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, row.fulfillmentId));
      await tx
        .update(replacementRequests)
        .set({
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(replacementRequests.replacementShipmentId, row.shipmentId));
      await refreshParentFulfillmentStatus(tx, {
        now,
        orderId: row.orderId,
      });
      await tx.insert(integrationAttempts).values({
        attemptNumber: row.attemptCount + 1,
        errorCode: failure.code,
        errorMessage: failure.message,
        finishedAt: now,
        outcome: "PERMANENT_FAILURE",
        outboxEventId: eventId,
        startedAt: now,
      });
      await tx.insert(auditLogs).values({
        action: "JIFENG_EXISTING_ORDER_MATCH_FAILED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          attemptNumber: row.attemptCount + 1,
          errorCode: failure.code,
          nextAttemptAt: null,
          retryable: false,
          platformOrderNo: row.platformOrderNo,
        },
        beforeJson: { status: row.fulfillmentStatus },
        entityId: row.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "平台订单号不是全局唯一，避免错误串绑",
      });
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-match:${row.fulfillmentId}:platform-order-no-not-unique`,
        entityId: row.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: "发现同一平台订单号下存在多个活跃包裹，请人工核查后再重试。",
        now,
        severity: "ERROR",
        title: "极风订单匹配阻断：平台订单号不唯一",
        type: "JIFENG_SUBMIT_FAILED",
      });
      return "FAILED" as const;
    }

    const attemptNumber = row.attemptCount + 1;
    const claimToken = crypto.randomUUID();
    await tx
      .update(integrationOutbox)
      .set({
        attemptCount: attemptNumber,
        claimToken,
        lastErrorCode: null,
        lastErrorMessage: null,
        lockedAt: now,
        status: "PROCESSING",
        updatedAt: now,
      })
      .where(eq(integrationOutbox.id, eventId));
    await tx
      .update(shipmentFulfillments)
      .set({
        attemptCount: attemptNumber,
        lastAttemptAt: now,
        status: row.fulfillmentStatus === "CANCELLED" ? "CANCELLED" : "SUBMITTING",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, row.fulfillmentId));

    return {
      attemptNumber,
      claimToken,
      fulfillmentId: row.fulfillmentId,
      orderId: row.orderId,
      platformOrderNo: row.platformOrderNo,
      shipmentId: row.shipmentId,
    isLocalCancelMonitoring:
        row.fulfillmentStatus === "CANCELLED" &&
        ["FAILED", "PENDING"].includes(row.eventStatus) &&
        row.eventLastErrorCode === "LOCAL_CANCEL_MONITORING",
      startedAt: now,
    } satisfies MatchClaim;
  });
}

async function recordMatchFailure(input: {
  claim: MatchClaim;
  eventId: string;
  failure: MatchFailure;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    await lockMatchRows(tx, {
      eventId: input.eventId,
      fulfillmentId: input.claim.fulfillmentId,
      orderId: input.claim.orderId,
    });
    const currentRows = await tx.execute<{
      claimToken: string | null;
      status: string;
    }>(sql`
      select claim_token as "claimToken", status
      from integration_outbox
      where id = ${input.eventId}
    `);
    const current = currentRows[0];
    if (
      !current ||
      current.status !== "PROCESSING" ||
      current.claimToken !== input.claim.claimToken
    ) {
      return "STALE" as const;
    }

    const nextAttemptAt = input.failure.retryable
      ? retryAt(input.now, input.claim.attemptNumber)
      : NEVER_RETRY_AT;
    const isLocalCancelMonitoring = input.claim.isLocalCancelMonitoring;
    const isTerminalShippedCancelConflict =
      isLocalCancelMonitoring &&
      input.failure.code === "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH" &&
      input.failure.remoteStatus === 7;
    const fulfillmentStatus = isTerminalShippedCancelConflict
      ? "EXCEPTION"
      : isLocalCancelMonitoring
        ? "CANCELLED"
      : input.failure.retryable
        ? "PENDING"
        : "EXCEPTION";
    await tx
      .update(shipmentFulfillments)
      .set({
        jifengStatus: input.failure.remoteStatus,
        lastErrorCode: input.failure.code,
        lastErrorMessage: input.failure.message,
        nextRetryAt: input.failure.retryable ? nextAttemptAt : null,
        status: fulfillmentStatus,
        updatedAt: input.now,
      })
      .where(eq(shipmentFulfillments.id, input.claim.fulfillmentId));
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        lastErrorCode: isLocalCancelMonitoring && !isTerminalShippedCancelConflict
          ? "LOCAL_CANCEL_MONITORING"
          : input.failure.code,
        lastErrorMessage: input.failure.message,
        lockedAt: null,
        nextAttemptAt,
        status: "FAILED",
        updatedAt: input.now,
      })
      .where(eq(integrationOutbox.id, input.eventId));
    if (!isLocalCancelMonitoring) {
      await tx
        .update(replacementRequests)
        .set({
          status: input.failure.retryable ? "PENDING_FULFILLMENT" : "EXCEPTION",
          updatedAt: input.now,
        })
        .where(
          eq(replacementRequests.replacementShipmentId, input.claim.shipmentId),
        );
    }
    if (!input.failure.retryable && !isLocalCancelMonitoring) {
      await refreshParentFulfillmentStatus(tx, {
        now: input.now,
        orderId: input.claim.orderId,
      });
    }
    await tx.insert(integrationAttempts).values({
      attemptNumber: input.claim.attemptNumber,
      errorCode: input.failure.code,
      errorMessage: input.failure.message,
      finishedAt: input.now,
      responseMetadata: {
        platformOrderNo: input.failure.platformOrderNo,
        remoteErpNo: input.failure.remoteErpNo,
        remoteOrderNo: input.failure.remoteOrderNo,
        remoteStatus: input.failure.remoteStatus,
        localCancelMonitoring: isLocalCancelMonitoring,
      },
      outcome: input.failure.retryable
        ? "RETRYABLE_FAILURE"
        : "PERMANENT_FAILURE",
      outboxEventId: input.eventId,
      startedAt: input.claim.startedAt,
    });
    await tx.insert(auditLogs).values({
      action: input.failure.retryable
        ? "JIFENG_EXISTING_ORDER_MATCH_WAITING"
        : "JIFENG_EXISTING_ORDER_MATCH_FAILED",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: {
        attemptNumber: input.claim.attemptNumber,
        errorCode: input.failure.code,
        nextAttemptAt: input.failure.retryable
          ? nextAttemptAt.toISOString()
          : null,
        platformOrderNo: input.failure.platformOrderNo,
        remoteErpNo: input.failure.remoteErpNo,
        remoteOrderNo: input.failure.remoteOrderNo,
        remoteStatus: input.failure.remoteStatus,
        localCancelMonitoring: isLocalCancelMonitoring,
        retryable: input.failure.retryable,
      },
      beforeJson: { status: isLocalCancelMonitoring ? "CANCELLED" : "SUBMITTING" },
      entityId: input.claim.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason: input.failure.retryable
        ? "等待极风已有订单按平台订单号出现"
        : "极风已有订单无法安全匹配",
    });

    if (!input.failure.retryable || input.claim.attemptNumber === 6) {
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-match:${input.claim.fulfillmentId}:${
          input.failure.retryable ? "waiting" : input.failure.code
        }`,
        entityId: input.claim.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: input.failure.retryable
          ? "系统多次未在极风找到该平台订单，请确认极风订单是否已导入。"
          : "极风返回的订单信息无法与该包裹唯一对应，请人工核查。",
        now: input.now,
        severity: input.failure.retryable ? "WARNING" : "ERROR",
        title: input.failure.retryable
          ? "极风订单仍待匹配"
          : "极风订单匹配失败",
        type: "JIFENG_SUBMIT_FAILED",
      });
    }
    return input.failure.retryable
      ? ("RETRY_SCHEDULED" as const)
      : ("FAILED" as const);
  });
}

function assertExactMatch(detail: JifengOrderDetail, platformOrderNo: string) {
  if (detail.platformOrderNo !== platformOrderNo) {
    throw new JifengOrderMatchError(
      "PLATFORM_ORDER_NO_MISMATCH",
      "极风返回的平台订单号与本地包裹不一致",
    );
  }
  const remoteErpNo = detail.erpNo.trim();
  if (!remoteErpNo || remoteErpNo.length > 100 || remoteErpNo !== detail.erpNo) {
    throw new JifengOrderMatchError(
      "REMOTE_ERP_NO_INVALID",
      "极风返回的 ERP 单号无效",
    );
  }
  return remoteErpNo;
}

async function finalizeExistingOrderMatch(input: {
  claim: MatchClaim;
  detail: JifengOrderDetail;
  eventId: string;
  now: Date;
  remoteErpNo: string;
}) {
  return db.transaction(async (tx) => {
    await lockMatchRows(tx, {
      eventId: input.eventId,
      fulfillmentId: input.claim.fulfillmentId,
      orderId: input.claim.orderId,
    });
    const currentRows = await tx.execute<{
      claimToken: string | null;
      eventStatus: string;
    }>(sql`
      select claim_token as "claimToken", status as "eventStatus"
      from integration_outbox
      where id = ${input.eventId}
    `);
    const current = currentRows[0];
    if (
      !current ||
      current.eventStatus !== "PROCESSING" ||
      current.claimToken !== input.claim.claimToken
    ) {
      return "STALE" as const;
    }

    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${input.remoteErpNo}, 0))
    `);
    const duplicateRows = await tx.execute<{ id: string }>(sql`
      select id
      from shipment_fulfillments
      where erp_no = ${input.remoteErpNo}
        and id <> ${input.claim.fulfillmentId}
      limit 1
    `);
    if (duplicateRows[0]) {
      throw new JifengOrderMatchError(
        "REMOTE_ORDER_ALREADY_BOUND",
        "该极风订单已绑定到其他系统包裹",
      );
    }

    await tx
      .update(shipmentFulfillments)
      .set({
        erpNo: input.remoteErpNo,
        externalOrderNo: input.detail.orderNo ?? null,
        lastErrorCode: null,
        lastErrorMessage: null,
        nextRetryAt: null,
        submittedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(shipmentFulfillments.id, input.claim.fulfillmentId));

    let mapped: Awaited<ReturnType<typeof applyJifengOrderStatus>>;
    try {
      mapped = await applyJifengOrderStatus(
        { detail: input.detail, now: input.now, source: "POLL" },
        tx,
      );
    } catch (error) {
      if (
        input.detail.status === 7 &&
        isRemoteShippedInventoryInvariantFailure(error)
      ) {
        const normalizedCurrency = input.detail.currency?.trim().toUpperCase();
        const shippedAt = input.detail.shippedTime
          ? new Date(input.detail.shippedTime)
          : null;
        const safeShippedAt =
          shippedAt && !Number.isNaN(shippedAt.getTime()) ? shippedAt : null;
        const feeMinor =
          input.detail.logisticsFee === undefined
            ? null
            : Math.round(input.detail.logisticsFee * 100);
        await tx
          .update(orderShipments)
          .set({
            logisticsCurrency:
              feeMinor === null
                ? null
                : normalizedCurrency && /^[A-Z]{3}$/.test(normalizedCurrency)
                  ? normalizedCurrency
                  : "CAD",
            logisticsFeeMinor: feeMinor,
            shippedAt: safeShippedAt,
            trackingNumber: input.detail.trackingNo?.trim() || null,
            updatedAt: input.now,
          })
          .where(eq(orderShipments.id, input.claim.shipmentId));
        await tx
          .update(shipmentFulfillments)
          .set({ shippedAt: safeShippedAt, updatedAt: input.now })
          .where(eq(shipmentFulfillments.id, input.claim.fulfillmentId));
        const failure: MatchFailure = {
          code: "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH",
          message:
            "极风显示已发货，但本地库存/锁定状态异常，系统已保存远端订单信息并转入人工异常。",
          retryable: false,
          platformOrderNo: input.claim.platformOrderNo,
          remoteErpNo: input.remoteErpNo,
          remoteOrderNo: input.detail.orderNo ?? undefined,
          remoteStatus: input.detail.status,
        };
        return {
          status: "FAILED",
          failure,
        };
      }
      throw error;
    }
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        completedAt: input.now,
        lastErrorCode: null,
        lastErrorMessage: null,
        lockedAt: null,
        status: "COMPLETED",
        updatedAt: input.now,
      })
      .where(eq(integrationOutbox.id, input.eventId));
    await tx.insert(integrationAttempts).values({
      attemptNumber: input.claim.attemptNumber,
      finishedAt: input.now,
      outcome: "SUCCESS",
      outboxEventId: input.eventId,
      responseMetadata: {
        jifengOrderNo: input.detail.orderNo ?? null,
        platformOrderNo: input.claim.platformOrderNo,
      },
      startedAt: input.claim.startedAt,
    });
    await tx.insert(auditLogs).values({
      action: "JIFENG_EXISTING_ORDER_MATCHED",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: {
        jifengOrderNo: input.detail.orderNo ?? null,
        jifengStatus: input.detail.status,
        remoteErpNo: input.remoteErpNo,
        status: mapped.status,
      },
      beforeJson: { platformOrderNo: input.claim.platformOrderNo },
      entityId: input.claim.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason: "已按平台订单号精确绑定极风已有订单",
    });
    await resolveSystemNotificationsByDeduplicationPrefix(tx, {
      deduplicationKeyPrefix: `jifeng-match:${input.claim.fulfillmentId}:`,
      now: input.now,
    });

    if (input.claim.isLocalCancelMonitoring && input.detail.status !== 9) {
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-match-after-cancel:${input.claim.fulfillmentId}`,
        entityId: input.claim.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: "本地包裹已取消，但极风仍存在未取消订单，请立即人工核查。",
        now: input.now,
        severity: "ERROR",
        title: "本地取消与极风订单不一致",
        type: "JIFENG_EXCEPTION",
      });
    }
    return "MATCHED" as const;
  });
}

type FinalizeResult =
  | "STALE"
  | "MATCHED"
  | { status: "FAILED"; failure: MatchFailure };

export async function processJifengExistingOrderMatchEvent(input: {
  client: JifengExistingOrderLookupPort;
  eventId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claim = await claimExistingOrderMatch(input.eventId, now);
  if (typeof claim === "string") {
    switch (claim) {
      case "BUSY":
        return { status: "BUSY" as const };
      case "CANCELLED":
        return { status: "SKIPPED_CANCELLED" as const };
      case "FAILED":
        return { status: "FAILED" as const };
      case "NOT_ELIGIBLE":
        return { status: "SKIPPED_NOT_ELIGIBLE" as const };
      case "COMPLETED":
        return { status: "ALREADY_COMPLETED" as const };
      default: {
        const exhaustive: never = claim;
        return exhaustive;
      }
    }
  }

  try {
    if (
      !claim.platformOrderNo.trim() ||
      claim.platformOrderNo.trim() !== claim.platformOrderNo
    ) {
      throw new JifengOrderMatchError(
        "PLATFORM_ORDER_NO_INVALID",
        "包裹平台订单号无效，无法匹配极风订单",
      );
    }
    const detail = await input.client.getOrder({
      platformOrderNo: claim.platformOrderNo,
    });
    const remoteErpNo = assertExactMatch(detail, claim.platformOrderNo);
    const result = await finalizeExistingOrderMatch({
      claim,
      detail,
      eventId: input.eventId,
      now,
      remoteErpNo,
    });
    if (typeof result === "object" && result.status === "FAILED") {
      return {
        status: await recordMatchFailure({
          claim,
          eventId: input.eventId,
          failure: {
            ...result.failure,
            platformOrderNo: claim.platformOrderNo,
          },
          now,
        }),
      };
    }
    return { status: result as Exclude<FinalizeResult, object> };
  } catch (error) {
    return {
      status: await recordMatchFailure({
        claim,
        eventId: input.eventId,
        failure: matchFailure(error),
        now,
      }),
    };
  }
}

export async function processDueJifengExistingOrderMatches(input: {
  client: JifengExistingOrderLookupPort;
  limit?: number;
  now?: Date;
}) {
  const limit = input.limit ?? 50;
  const queryNow = input.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("极风订单匹配批量大小必须在 1 到 200 之间");
  }
  const staleLeaseCutoff = new Date(queryNow.getTime() - JIFENG_MATCH_LEASE_MS);
  const events = await db.execute<{ id: string }>(sql`
    select id
      from integration_outbox
      where target = 'JIFENG'
        and event_type = ${LEGACY_MATCH_EVENT_TYPE}
        and (
          (status in ('PENDING', 'FAILED')
          and next_attempt_at <= ${queryNow.toISOString()}::timestamptz)
        or (status = 'PROCESSING'
          and (
            locked_at is null
            or locked_at <= ${staleLeaseCutoff.toISOString()}::timestamptz
          ))
      )
    order by coalesce(locked_at, next_attempt_at), id
    limit ${limit}
  `);

  const summary = { completed: 0, failed: 0, retryScheduled: 0 };
  for (const event of events) {
    const eventNow = input.now ?? new Date();
    const result = await processJifengExistingOrderMatchEvent({
      client: input.client,
      eventId: event.id,
      now: eventNow,
    });
    if (["MATCHED", "ALREADY_COMPLETED"].includes(result.status)) {
      summary.completed += 1;
    } else if (result.status === "RETRY_SCHEDULED") {
      summary.retryScheduled += 1;
    } else if (result.status === "FAILED") {
      summary.failed += 1;
    }
  }
  return summary;
}
