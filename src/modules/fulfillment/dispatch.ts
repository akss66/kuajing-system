import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  integrationOutbox,
  replacementRequests,
  shipmentFulfillments,
} from "@/db/schema";

import { refreshParentFulfillmentStatus } from "./order-rollup";
import { JIFENG_MATCH_LEASE_MS } from "./order-matching";

// This persisted event name predates match-only fulfillment. Keep it until a
// dedicated data migration renames historical outbox rows and idempotency keys.
const JIFENG_MATCH_EVENT_TYPE = "JIFENG_CREATE_ORDER";

export class JifengDispatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "JifengDispatchError";
  }
}

function erpNumberForShipment(shipmentId: string) {
  return `TZX-${shipmentId.replaceAll("-", "")}`;
}

function asDate(value: Date | string | null) {
  return value instanceof Date ? value : value ? new Date(value) : null;
}

function leaseExpired(lockedAt: Date | string | null, now: Date) {
  const claimedAt = asDate(lockedAt);
  return claimedAt === null ||
    claimedAt.getTime() + JIFENG_MATCH_LEASE_MS <= now.getTime();
}

export async function enqueuePaidOrdersForFulfillment(input?: {
  limit?: number;
  now?: Date;
}) {
  const limit = input?.limit ?? 100;
  const now = input?.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("履约入队批量大小必须在 1 到 500 之间");
  }

  return db.transaction(async (tx) => {
    const eligible = await tx.execute<{ orderId: string; shipmentId: string }>(sql`
      select
        shipment.id as "shipmentId",
        shipment.order_id as "orderId"
      from order_shipments shipment
      inner join fulfillment_orders parent on parent.id = shipment.order_id
      left join shipment_fulfillments fulfillment
        on fulfillment.shipment_id = shipment.id
      where parent.status = 'PAID_PENDING_FULFILLMENT'
        and fulfillment.id is null
      order by parent.paid_at, shipment.id
      for update of shipment skip locked
      limit ${limit}
    `);

    let enqueued = 0;
    for (const candidate of eligible) {
      const [fulfillment] = await tx
        .insert(shipmentFulfillments)
        .values({
          erpNo: erpNumberForShipment(candidate.shipmentId),
          shipmentId: candidate.shipmentId,
        })
        .onConflictDoNothing()
        .returning({ id: shipmentFulfillments.id });
      if (!fulfillment) continue;

      const [event] = await tx
        .insert(integrationOutbox)
        .values({
          aggregateId: candidate.shipmentId,
          aggregateType: "SHIPMENT",
          eventType: JIFENG_MATCH_EVENT_TYPE,
          // Keep the historical key stable so a deployment cannot enqueue a
          // second event for an already-paid package.
          idempotencyKey: `jifeng:create:${candidate.shipmentId}`,
          nextAttemptAt: now,
          payload: { shipmentId: candidate.shipmentId },
          target: "JIFENG",
        })
        .onConflictDoNothing()
        .returning({ id: integrationOutbox.id });
      if (event) enqueued += 1;
    }
    return enqueued;
  });
}

export async function retryJifengShipment(input: {
  actorUserId: string;
  now?: Date;
  reason: string;
  shipmentId: string;
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new JifengDispatchError("REASON_REQUIRED", "重试极风履约必须填写原因");
  }
  const now = input.now ?? new Date();
  const references = await db.execute<{ orderId: string }>(sql`
    select order_id as "orderId"
    from order_shipments
    where id = ${input.shipmentId}
  `);
  const reference = references[0];
  if (!reference) {
    throw new JifengDispatchError("SHIPMENT_NOT_FOUND", "未找到极风履约包裹");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select id from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const rows = await tx.execute<{
      externalOrderNo: string | null;
      fulfillmentId: string;
      jifengStatus: number | null;
      orderId: string;
      replacementRequestId: string | null;
      status: string;
      submittedAt: Date | string | null;
    }>(sql`
      select
        fulfillment.external_order_no as "externalOrderNo",
        fulfillment.id as "fulfillmentId",
        fulfillment.jifeng_status as "jifengStatus",
        fulfillment.status,
        fulfillment.submitted_at as "submittedAt",
        shipment.order_id as "orderId",
        replacement.id as "replacementRequestId"
      from shipment_fulfillments fulfillment
      inner join order_shipments shipment
        on shipment.id = fulfillment.shipment_id
      left join replacement_requests replacement
        on replacement.replacement_shipment_id = shipment.id
      where shipment.id = ${input.shipmentId}
      for update of fulfillment
    `);
    const fulfillment = rows[0];
    if (!fulfillment) {
      throw new JifengDispatchError("FULFILLMENT_NOT_FOUND", "未找到极风履约包裹");
    }
    if (["SHIPPED", "CANCEL_PENDING", "CANCELLED"].includes(fulfillment.status)) {
      throw new JifengDispatchError(
        "FULFILLMENT_TERMINAL",
        "已发货、取消确认中或已取消包裹不能重试",
      );
    }
    if (fulfillment.status !== "EXCEPTION") {
      throw new JifengDispatchError(
        "FULFILLMENT_NOT_FAILED",
        "只有异常包裹可以重试",
      );
    }

    const alreadyMatched =
      fulfillment.submittedAt !== null ||
      fulfillment.externalOrderNo !== null ||
      fulfillment.jifengStatus !== null;
    if (alreadyMatched) {
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: now,
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, fulfillment.fulfillmentId));
      await tx.insert(auditLogs).values({
        action: "JIFENG_SHIPMENT_RETRY_REQUESTED",
        actorId: input.actorUserId,
        actorType: "ADMIN",
        afterJson: { recoveryMode: "STATUS_QUERY", status: fulfillment.status },
        beforeJson: { status: fulfillment.status },
        entityId: input.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason,
      });
      return { status: "STATUS_REFRESH_SCHEDULED" as const };
    }

    const eventRows = await tx.execute<{
      id: string;
      lockedAt: Date | string | null;
      status: string;
    }>(sql`
      select id, locked_at as "lockedAt", status
      from integration_outbox
      where aggregate_id = ${input.shipmentId}
        and event_type = ${JIFENG_MATCH_EVENT_TYPE}
      for update
    `);
    const event = eventRows[0];
    if (!event) {
      throw new JifengDispatchError(
        "MATCH_EVENT_NOT_FOUND",
        "未找到极风已有订单匹配任务",
      );
    }
    if (event.status === "PROCESSING" && !leaseExpired(event.lockedAt, now)) {
      throw new JifengDispatchError(
        "MATCH_IN_PROGRESS",
        "极风已有订单正在匹配，请勿重复重试",
      );
    }

    await tx
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: null,
        lastErrorMessage: null,
        nextRetryAt: now,
        status: "PENDING",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, fulfillment.fulfillmentId));
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lockedAt: null,
        nextAttemptAt: now,
        status: "PENDING",
        updatedAt: now,
      })
      .where(
        and(
          eq(integrationOutbox.id, event.id),
          eq(integrationOutbox.eventType, JIFENG_MATCH_EVENT_TYPE),
        ),
      );
    await tx
      .update(replacementRequests)
      .set({ status: "PENDING_FULFILLMENT", updatedAt: now })
      .where(eq(replacementRequests.replacementShipmentId, input.shipmentId));
    if (!fulfillment.replacementRequestId) {
      await refreshParentFulfillmentStatus(tx, {
        now,
        orderId: fulfillment.orderId,
      });
    }
    await tx.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_RETRY_REQUESTED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: { recoveryMode: "EXISTING_ORDER_MATCH", status: "PENDING" },
      beforeJson: { status: fulfillment.status },
      entityId: input.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason,
    });
    return { status: "PENDING" as const };
  });
}
