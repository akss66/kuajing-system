import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  integrationAttempts,
  integrationOutbox,
  orderLines,
  orderShipments,
  replacementRequests,
  shipmentFulfillments,
  stores,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import type {
  JifengCreateOrderInput,
  JifengOrderDetail,
} from "@/integrations/jifeng/types";
import { decryptPii } from "@/shared/pii-crypto";
import { createSystemNotification } from "@/modules/notifications/service";
import {
  applyJifengOrderStatus,
  nextJifengStatusPollAt,
} from "@/modules/fulfillment/status-sync";

import { refreshParentFulfillmentStatus } from "./order-rollup";

const recipientSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: z.string().nullable(),
  addressLine3: z.string().nullable(),
  alternatePhone: z.string().nullable(),
  city: z.string().min(1),
  country: z.string().min(1),
  district: z.string().nullable(),
  email: z.string().nullable(),
  identityNumber: z.string().nullable(),
  name: z.string().min(1),
  phone: z.string().min(1),
  postalCode: z.string().min(1),
  province: z.string().min(1),
  taxNumber: z.string().nullable(),
});

export type JifengCreateOrderPort = {
  createOrder(input: JifengCreateOrderInput): Promise<{
    data: unknown;
    requestId?: string;
  }>;
  getOrder?(input: { erpNo: string }): Promise<JifengOrderDetail>;
};

export type DispatchConfig = {
  logisticsId: number;
  warehouseCode: string;
};

type ClaimedEvent = {
  attemptNumber: number;
  claimToken: string;
  fulfillmentId: string;
  orderId: string;
  shipmentId: string;
  startedAt: Date;
};

type RetryInspection = {
  attemptCount: number;
  erpNo: string;
  fulfillmentId: string;
  lastErrorCode: string | null;
  orderId: string;
  shipmentId: string;
  status: string;
};

type ReconciliationClaim = RetryInspection & {
  claimToken: string;
  priorErrorCode: string;
};

export const JIFENG_RECONCILIATION_LEASE_MS = 5 * 60 * 1000;

export class JifengDispatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "JifengDispatchError";
  }
}

const MANUAL_CONFIRMED_RETRY = "MANUAL_CONFIRMED_FAILURE_RETRY";
const RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED";
const CONFIRMED_NOT_FOUND_CODES = new Set(["50017", "50071"]);
const QUERY_ONLY_PRIOR_CODES = new Set(["50019", "50038"]);
const CREATE_AFTER_NOT_FOUND_CODES = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "INVALID_RESPONSE",
  "POST_SUCCESS_PERSISTENCE_ERROR",
  "STALE_PROCESSING",
]);

function reconciliationOrigin(code: string | null) {
  const prefix = `${RECONCILIATION_REQUIRED}:`;
  return code?.startsWith(prefix) ? code.slice(prefix.length) : code ?? "UNKNOWN";
}

function reconciliationStateCode(origin: string) {
  return `${RECONCILIATION_REQUIRED}:${origin}`.slice(0, 80);
}

function erpNumberForShipment(shipmentId: string) {
  return `TZX-${shipmentId.replaceAll("-", "")}`;
}

function retryAt(now: Date, attemptNumber: number) {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** (attemptNumber - 1));
  return new Date(now.getTime() + delayMs);
}

function safeFailure(error: unknown) {
  if (error instanceof JifengApiError) {
    return {
      code: error.code.slice(0, 80),
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "极风履约任务处理失败",
    retryable: true,
  };
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
        s.id as "shipmentId",
        s.order_id as "orderId"
      from order_shipments s
      inner join fulfillment_orders o on o.id = s.order_id
      left join shipment_fulfillments f on f.shipment_id = s.id
      where o.status = 'PAID_PENDING_FULFILLMENT'
        and f.id is null
      order by o.paid_at, s.id
      for update of s skip locked
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
          eventType: "JIFENG_CREATE_ORDER",
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

async function claimEvent(eventId: string, now: Date) {
  return db.transaction(async (
    tx,
  ): Promise<
    ClaimedEvent | "COMPLETED" | "BUSY" | "CANCELLED" | "NOT_ELIGIBLE"
  > => {
    const references = await tx.execute<{ orderId: string }>(sql`
      select s.order_id as "orderId"
      from integration_outbox e
      inner join order_shipments s on s.id::text = e.aggregate_id
      where e.id = ${eventId}
        and e.target = 'JIFENG'
        and e.event_type = 'JIFENG_CREATE_ORDER'
    `);
    const reference = references[0];
    if (!reference) throw new Error("Jifeng create event not found");
    const orderRows = await tx.execute<{ status: string }>(sql`
      select status
      from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const order = orderRows[0];
    if (!order) throw new Error("Jifeng event order not found");
    const rows = await tx.execute<{
      attemptCount: number;
      fulfillmentId: string;
      lastErrorCode: string | null;
      orderId: string;
      replacementRequestId: string | null;
      replacementStatus: string | null;
      shipmentId: string;
      status: string;
    }>(sql`
      select
        e.status,
        e.attempt_count as "attemptCount",
        e.last_error_code as "lastErrorCode",
        f.id as "fulfillmentId",
        s.id as "shipmentId",
        s.order_id as "orderId",
        r.id as "replacementRequestId",
        r.status as "replacementStatus"
      from integration_outbox e
      inner join shipment_fulfillments f on f.shipment_id::text = e.aggregate_id
      inner join order_shipments s on s.id = f.shipment_id
      left join replacement_requests r on r.replacement_shipment_id = s.id
      where e.id = ${eventId}
        and e.target = 'JIFENG'
        and e.event_type = 'JIFENG_CREATE_ORDER'
      for update of e, f
    `);
    const event = rows[0];
    if (!event) throw new Error("未找到极风创建订单任务");
    if (event.status === "COMPLETED" && event.lastErrorCode === "ORDER_CANCELLED") {
      return "CANCELLED";
    }
    if (event.status === "COMPLETED") return "COMPLETED";
    if (event.status === "PROCESSING") return "BUSY";
    const replacementEligible =
      event.replacementRequestId !== null &&
      ["PENDING_FULFILLMENT", "EXCEPTION"].includes(
        event.replacementStatus ?? "",
      );
    const orderEligibleForPackageDispatch = [
      "PAID_PENDING_FULFILLMENT",
      "FULFILLING",
      "FULFILLMENT_EXCEPTION",
    ].includes(order.status);
    if (!orderEligibleForPackageDispatch && !replacementEligible) {
      const skippedAs =
        order.status === "CANCELLED" ? "CANCELLED" : "NOT_ELIGIBLE";
      const errorCode =
        skippedAs === "CANCELLED" ? "ORDER_CANCELLED" : "ORDER_NOT_ELIGIBLE";
      await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          completedAt: now,
          lastErrorCode: errorCode,
          lastErrorMessage: "Local order is not eligible for dispatch",
          lockedAt: null,
          status: "COMPLETED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, eventId));
      await tx
        .update(shipmentFulfillments)
        .set({
          cancelledAt: skippedAs === "CANCELLED" ? now : null,
          lastErrorCode: errorCode,
          lastErrorMessage: "Local order is not eligible for dispatch",
          nextRetryAt: null,
          status: "CANCELLED",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, event.fulfillmentId));
      return skippedAs;
    }

    const attemptNumber = event.attemptCount + 1;
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
        status: "SUBMITTING",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, event.fulfillmentId));

    return {
      attemptNumber,
      claimToken,
      fulfillmentId: event.fulfillmentId,
      orderId: event.orderId,
      shipmentId: event.shipmentId,
      startedAt: now,
    };
  });
}

async function buildCreateOrderInput(
  shipmentId: string,
  config: DispatchConfig,
): Promise<JifengCreateOrderInput> {
  const [shipment] = await db
    .select({
      encryptedRecipient: orderShipments.recipientPayloadEncrypted,
      erpNo: shipmentFulfillments.erpNo,
      externalOrderNo: orderShipments.externalOrderNo,
      orderNumber: fulfillmentOrders.orderNumber,
      storeName: stores.name,
    })
    .from(shipmentFulfillments)
    .innerJoin(orderShipments, eq(orderShipments.id, shipmentFulfillments.shipmentId))
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, orderShipments.orderId))
    .innerJoin(stores, eq(stores.id, orderShipments.storeId))
    .where(eq(orderShipments.id, shipmentId))
    .limit(1);
  if (!shipment) throw new Error("履约包裹不存在");

  const lines = await db
    .select({
      name: orderLines.skuNameSnapshot,
      priceFen: orderLines.unitPriceFen,
      quantity: orderLines.quantity,
      sku: orderLines.skuCodeSnapshot,
    })
    .from(orderLines)
    .where(eq(orderLines.shipmentId, shipmentId));
  if (lines.length === 0) throw new Error("履约包裹没有商品明细");

  const recipient = recipientSchema.parse(decryptPii<unknown>(shipment.encryptedRecipient));
  const address2 = [recipient.addressLine2, recipient.addressLine3]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  const amountFen = lines.reduce(
    (sum, line) => sum + line.priceFen * line.quantity,
    0,
  );

  return {
    amount: amountFen > 0 ? amountFen / 100 : undefined,
    buyerName: recipient.name,
    buyerPhone: recipient.phone,
    currency: "CNY",
    erpNo: shipment.erpNo,
    logisticsId: config.logisticsId,
    note: `同舟行拿货单 ${shipment.orderNumber}`,
    packageType: 3,
    platform: "temu",
    platformOrderNo: shipment.externalOrderNo,
    recipientAddress: recipient.addressLine1,
    recipientAddress2: address2 || undefined,
    recipientArea: recipient.district ?? undefined,
    recipientCity: recipient.city,
    recipientCountry: "CA",
    recipientEmail: recipient.email ?? undefined,
    recipientProvince: recipient.province,
    shopName: shipment.storeName,
    skuList: lines.map((line) => ({
      itemNameCn: line.name,
      num: line.quantity,
      sku: line.sku,
      unitPrice: line.priceFen / 100,
    })),
    type: 2,
    warehouse: config.warehouseCode,
    zipCode: recipient.postalCode,
  };
}

async function lockDispatchRows(
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

async function reconciliationRow(
  tx: DbTransaction,
  eventId: string,
): Promise<
  | (RetryInspection & {
      fulfillmentStatus: string;
      claimToken: string | null;
      lockedAt: Date | string | null;
    })
  | null
> {
  const rows = await tx.execute<
    RetryInspection & {
      fulfillmentStatus: string;
      claimToken: string | null;
      lockedAt: Date | string | null;
    }
  >(sql`
    select
      e.attempt_count as "attemptCount",
      e.claim_token as "claimToken",
      f.erp_no as "erpNo",
      f.id as "fulfillmentId",
      f.status as "fulfillmentStatus",
      e.last_error_code as "lastErrorCode",
      e.locked_at as "lockedAt",
      s.order_id as "orderId",
      s.id as "shipmentId",
      e.status
    from integration_outbox e
    inner join shipment_fulfillments f on f.shipment_id::text = e.aggregate_id
    inner join order_shipments s on s.id = f.shipment_id
    where e.id = ${eventId}
      and e.target = 'JIFENG'
      and e.event_type = 'JIFENG_CREATE_ORDER'
  `);
  return rows[0] ?? null;
}

function sameClaim(
  row: { claimToken: string | null; status: string },
  claim: ReconciliationClaim,
) {
  return ownsProcessingClaim(row, claim.claimToken);
}

function ownsProcessingClaim(
  row: { claimToken: string | null; status: string },
  claimToken: string,
) {
  return row.status === "PROCESSING" && row.claimToken === claimToken;
}

function asDate(value: Date | string | null) {
  return value instanceof Date ? value : value ? new Date(value) : null;
}

function reconciliationLeaseExpired(
  lockedAt: Date | string | null,
  now: Date,
) {
  const claimedAt = asDate(lockedAt);
  return claimedAt !== null &&
    claimedAt.getTime() + JIFENG_RECONCILIATION_LEASE_MS <= now.getTime();
}

async function claimReconciliation(eventId: string, now: Date) {
  const references = await db.execute<{
    fulfillmentId: string;
    orderId: string;
  }>(sql`
    select f.id as "fulfillmentId", s.order_id as "orderId"
    from integration_outbox e
    inner join shipment_fulfillments f on f.shipment_id::text = e.aggregate_id
    inner join order_shipments s on s.id = f.shipment_id
    where e.id = ${eventId}
      and e.target = 'JIFENG'
      and e.event_type = 'JIFENG_CREATE_ORDER'
  `);
  const reference = references[0];
  if (!reference) return "CREATE" as const;
  return db.transaction(async (tx) => {
    await lockDispatchRows(tx, { eventId, ...reference });
    const row = await reconciliationRow(tx, eventId);
    if (!row) return "CREATE" as const;
    if (row.status === "COMPLETED") {
      if (row.lastErrorCode === "ORDER_CANCELLED") return "CANCELLED" as const;
      if (row.lastErrorCode === "ORDER_NOT_ELIGIBLE") {
        return "NOT_ELIGIBLE" as const;
      }
      return "COMPLETED" as const;
    }
    const reclaimingStaleClaim =
      row.status === "PROCESSING" && reconciliationLeaseExpired(row.lockedAt, now);
    if (row.status === "PROCESSING" && !reclaimingStaleClaim) {
      return "BUSY" as const;
    }
    if (
      !reclaimingStaleClaim &&
      (row.status !== "FAILED" ||
      row.attemptCount === 0 ||
      row.lastErrorCode === MANUAL_CONFIRMED_RETRY)
    ) {
      return "CREATE" as const;
    }
    const claimToken = crypto.randomUUID();
    await tx
      .update(integrationOutbox)
      .set({ claimToken, lockedAt: now, status: "PROCESSING", updatedAt: now })
      .where(eq(integrationOutbox.id, eventId));
    return {
      ...row,
      claimToken,
      priorErrorCode: reclaimingStaleClaim
        ? reconciliationOrigin(row.lastErrorCode) === "UNKNOWN"
          ? "STALE_PROCESSING"
          : reconciliationOrigin(row.lastErrorCode)
        : reconciliationOrigin(row.lastErrorCode),
    } satisfies ReconciliationClaim;
  });
}

async function completeAlreadyTerminalClaim(
  tx: DbTransaction,
  eventId: string,
  now: Date,
) {
  await tx
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
    .where(eq(integrationOutbox.id, eventId));
}

async function markReconciliationRequired(
  inspected: ReconciliationClaim,
  eventId: string,
  now: Date,
  errorCode: string,
) {
  return db.transaction(async (tx) => {
    await lockDispatchRows(tx, {
      eventId,
      fulfillmentId: inspected.fulfillmentId,
      orderId: inspected.orderId,
    });
    const current = await reconciliationRow(tx, eventId);
    if (!current) return "STALE" as const;
    if (!sameClaim(current, inspected)) return "STALE" as const;
    if (
      current.status === "COMPLETED" ||
      ["SUBMITTED", "FULFILLING", "SHIPPED", "CANCELLED"].includes(
        current.fulfillmentStatus,
      )
    ) {
      if (current.status !== "COMPLETED") {
        await completeAlreadyTerminalClaim(tx, eventId, now);
      }
      return "TERMINAL" as const;
    }
    const neverRetryAt = new Date("9999-12-31T23:59:59.999Z");
    const stateCode = reconciliationStateCode(inspected.priorErrorCode);
    await tx
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: stateCode,
        lastErrorMessage: "Jifeng order outcome requires reconciliation",
        nextRetryAt: neverRetryAt,
        status: "EXCEPTION",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, inspected.fulfillmentId));
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        lastErrorCode: stateCode,
        lastErrorMessage: "Jifeng order outcome requires reconciliation",
        lockedAt: null,
        nextAttemptAt: neverRetryAt,
        status: "FAILED",
        updatedAt: now,
      })
      .where(eq(integrationOutbox.id, eventId));
    await refreshParentFulfillmentStatus(tx, {
      now,
      orderId: inspected.orderId,
    });
    await tx.insert(auditLogs).values({
      action: "JIFENG_ORDER_RECONCILIATION_REQUIRED",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: {
        errorCode,
        priorErrorCode: inspected.priorErrorCode,
        status: RECONCILIATION_REQUIRED,
      },
      beforeJson: { status: inspected.status },
      entityId: inspected.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: "Jifeng create outcome could not be confirmed safely",
    });
    return "APPLIED" as const;
  });
}

async function finalizeRemoteOrder(
  inspected: ReconciliationClaim,
  eventId: string,
  detail: JifengOrderDetail,
  now: Date,
) {
  return db.transaction(async (tx) => {
    await lockDispatchRows(tx, {
      eventId,
      fulfillmentId: inspected.fulfillmentId,
      orderId: inspected.orderId,
    });
    const current = await reconciliationRow(tx, eventId);
    if (!current) return "STALE" as const;
    if (!sameClaim(current, inspected)) return "STALE" as const;
    if (
      current.status === "COMPLETED" ||
      ["SHIPPED", "CANCELLED"].includes(current.fulfillmentStatus)
    ) {
      if (current.status !== "COMPLETED") {
        await completeAlreadyTerminalClaim(tx, eventId, now);
      }
      return "TERMINAL" as const;
    }
    const mapped = await applyJifengOrderStatus(
      { detail, now, source: "POLL" },
      tx,
    );
    await tx
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
      .where(eq(integrationOutbox.id, eventId));
    await tx.insert(auditLogs).values({
      action: "JIFENG_ORDER_RECONCILED",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: { jifengStatus: detail.status, status: mapped.status },
      beforeJson: { status: inspected.status },
      entityId: inspected.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: "Existing Jifeng order confirmed by ERP number",
    });
    return "APPLIED" as const;
  });
}

async function releaseClaimForConfirmedNotFound(
  claim: ReconciliationClaim,
  eventId: string,
  now: Date,
) {
  return db.transaction(async (tx) => {
    await lockDispatchRows(tx, {
      eventId,
      fulfillmentId: claim.fulfillmentId,
      orderId: claim.orderId,
    });
    const current = await reconciliationRow(tx, eventId);
    if (!current || !sameClaim(current, claim)) return false;
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        lastErrorCode: `CONFIRMED_NOT_FOUND:${claim.priorErrorCode}`.slice(0, 80),
        lastErrorMessage: "Jifeng order confirmed absent before create retry",
        lockedAt: null,
        status: "FAILED",
        updatedAt: now,
      })
      .where(eq(integrationOutbox.id, eventId));
    return true;
  });
}

async function reconcileBeforeCreateRetry(input: {
  client: JifengCreateOrderPort;
  eventId: string;
  now: Date;
}) {
  const inspected = await claimReconciliation(input.eventId, input.now);
  if (typeof inspected === "string") return inspected;
  if (!input.client.getOrder) {
    const outcome = await markReconciliationRequired(
      inspected,
      input.eventId,
      input.now,
      "QUERY_UNAVAILABLE",
    );
    if (outcome === "TERMINAL") return "COMPLETED" as const;
    if (outcome === "STALE") return "STALE" as const;
    return "RECONCILIATION_REQUIRED" as const;
  }
  try {
    const detail = await input.client.getOrder({ erpNo: inspected.erpNo });
    const outcome = await finalizeRemoteOrder(
      inspected,
      input.eventId,
      detail,
      input.now,
    );
    if (outcome === "APPLIED") return "RECONCILED" as const;
    if (outcome === "STALE") return "STALE" as const;
    return "COMPLETED" as const;
  } catch (error) {
    if (error instanceof JifengApiError && CONFIRMED_NOT_FOUND_CODES.has(error.code)) {
      if (
        !QUERY_ONLY_PRIOR_CODES.has(inspected.priorErrorCode) &&
        CREATE_AFTER_NOT_FOUND_CODES.has(inspected.priorErrorCode)
      ) {
        return await releaseClaimForConfirmedNotFound(
          inspected,
          input.eventId,
          input.now,
        )
          ? ("CREATE" as const)
          : ("STALE" as const);
      }
      const outcome = await markReconciliationRequired(
        inspected,
        input.eventId,
        input.now,
        error.code,
      );
      if (outcome === "TERMINAL") return "COMPLETED" as const;
      if (outcome === "STALE") return "STALE" as const;
      return "RECONCILIATION_REQUIRED" as const;
    }
    const failure = safeFailure(error);
    const outcome = await markReconciliationRequired(
      inspected,
      input.eventId,
      input.now,
      failure.code,
    );
    if (outcome === "TERMINAL") return "COMPLETED" as const;
    if (outcome === "STALE") return "STALE" as const;
    return "RECONCILIATION_REQUIRED" as const;
  }
}

export async function processJifengCreateOrderEvent(input: {
  client: JifengCreateOrderPort;
  config: DispatchConfig;
  eventId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reconciliation = await reconcileBeforeCreateRetry({
    client: input.client,
    eventId: input.eventId,
    now,
  });
  if (reconciliation !== "CREATE") {
    switch (reconciliation) {
      case "RECONCILED":
        return { status: "RECONCILED" as const };
      case "RECONCILIATION_REQUIRED":
        return { status: "RECONCILIATION_REQUIRED" as const };
      case "BUSY":
        return { status: "BUSY" as const };
      case "COMPLETED":
        return { status: "ALREADY_COMPLETED" as const };
      case "STALE":
        return { status: "STALE" as const };
      case "CANCELLED":
        return { status: "SKIPPED_CANCELLED" as const };
      case "NOT_ELIGIBLE":
        return { status: "SKIPPED_NOT_ELIGIBLE" as const };
      default: {
        const exhaustive: never = reconciliation;
        return exhaustive;
      }
    }
  }
  const claimed = await claimEvent(input.eventId, now);
  if (claimed === "CANCELLED") return { status: "SKIPPED_CANCELLED" as const };
  if (claimed === "NOT_ELIGIBLE") return { status: "SKIPPED_NOT_ELIGIBLE" as const };
  if (claimed === "COMPLETED") return { status: "ALREADY_COMPLETED" as const };
  if (claimed === "BUSY") return { status: "BUSY" as const };

  let externalCreateSucceeded = false;
  try {
    const request = await buildCreateOrderInput(claimed.shipmentId, input.config);
    const response = await input.client.createOrder(request);
    externalCreateSucceeded = true;

    const persisted = await db.transaction(async (tx) => {
      await lockDispatchRows(tx, {
        eventId: input.eventId,
        fulfillmentId: claimed.fulfillmentId,
        orderId: claimed.orderId,
      });
      const current = await reconciliationRow(tx, input.eventId);
      if (!current || !ownsProcessingClaim(current, claimed.claimToken)) {
        return false;
      }
      const orderRows = await tx.execute<{ status: string }>(sql`
        select status
        from fulfillment_orders
        where id = ${claimed.orderId}
      `);
      const orderStatusBefore = orderRows[0]?.status ?? null;
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: nextJifengStatusPollAt(now),
          status: "SUBMITTED",
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
      await tx
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
        .where(eq(integrationOutbox.id, input.eventId));
      await tx
        .update(replacementRequests)
        .set({ status: "FULFILLING", updatedAt: now })
        .where(eq(replacementRequests.replacementShipmentId, claimed.shipmentId));
      const orderStatus = await refreshParentFulfillmentStatus(tx, {
        now,
        orderId: claimed.orderId,
      });
      await tx.insert(integrationAttempts).values({
        attemptNumber: claimed.attemptNumber,
        finishedAt: now,
        outcome: "SUCCESS",
        outboxEventId: input.eventId,
        responseMetadata: response.requestId
          ? { requestId: response.requestId }
          : {},
        startedAt: claimed.startedAt,
      });
      await tx.insert(auditLogs).values({
        action: "JIFENG_ORDER_SUBMITTED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          attemptNumber: claimed.attemptNumber,
          fulfillmentStatus: "SUBMITTED",
          orderStatus,
        },
        beforeJson: {
          fulfillmentStatus: "PENDING",
          orderStatus: orderStatusBefore,
        },
        entityId: claimed.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: "已将包裹提交至极风履约",
      });
      return true;
    });

    if (!persisted) return { status: "STALE" as const };
    return { status: "COMPLETED" as const };
  } catch (error) {
    if (externalCreateSucceeded) {
      const outcome = await markReconciliationRequired(
        {
          attemptCount: claimed.attemptNumber,
          claimToken: claimed.claimToken,
          erpNo: erpNumberForShipment(claimed.shipmentId),
          fulfillmentId: claimed.fulfillmentId,
          lastErrorCode: "POST_SUCCESS_PERSISTENCE_ERROR",
          orderId: claimed.orderId,
          priorErrorCode: "POST_SUCCESS_PERSISTENCE_ERROR",
          shipmentId: claimed.shipmentId,
          status: "PROCESSING",
        },
        input.eventId,
        now,
        "POST_SUCCESS_PERSISTENCE_ERROR",
      );
      if (outcome === "STALE") return { status: "STALE" as const };
      if (outcome === "TERMINAL") {
        return { status: "ALREADY_COMPLETED" as const };
      }
      return { status: "RECONCILIATION_REQUIRED" as const };
    }
    const failure = safeFailure(error);
    const requiresReconciliation =
      failure.retryable || ["50019", "50038"].includes(failure.code);
    const nextAttemptAt = requiresReconciliation
      ? retryAt(now, claimed.attemptNumber)
      : new Date("9999-12-31T23:59:59.999Z");

    const persisted = await db.transaction(async (tx) => {
      await lockDispatchRows(tx, {
        eventId: input.eventId,
        fulfillmentId: claimed.fulfillmentId,
        orderId: claimed.orderId,
      });
      const current = await reconciliationRow(tx, input.eventId);
      if (!current || !ownsProcessingClaim(current, claimed.claimToken)) {
        return false;
      }
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          nextRetryAt: nextAttemptAt,
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
      await tx
        .update(integrationOutbox)
        .set({
          claimToken: null,
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          lockedAt: null,
          nextAttemptAt,
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, input.eventId));
      await tx
        .update(replacementRequests)
        .set({ status: "EXCEPTION", updatedAt: now })
        .where(eq(replacementRequests.replacementShipmentId, claimed.shipmentId));
      await refreshParentFulfillmentStatus(tx, {
        now,
        orderId: claimed.orderId,
      });
      await tx.insert(integrationAttempts).values({
        attemptNumber: claimed.attemptNumber,
        errorCode: failure.code,
        errorMessage: failure.message,
        finishedAt: now,
        outcome: requiresReconciliation ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
        outboxEventId: input.eventId,
        startedAt: claimed.startedAt,
      });
      await tx.insert(auditLogs).values({
        action: "JIFENG_ORDER_SUBMISSION_FAILED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          attemptNumber: claimed.attemptNumber,
          errorCode: failure.code,
          fulfillmentStatus: "EXCEPTION",
          retryable: requiresReconciliation,
        },
        beforeJson: { fulfillmentStatus: "SUBMITTING" },
        entityId: claimed.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: "极风履约提交失败，已记录安全错误摘要",
      });
      if (claimed.attemptNumber >= 3) {
        await createSystemNotification(tx, {
          deduplicationKey: `jifeng-submit-failed:${claimed.fulfillmentId}`,
          entityId: claimed.fulfillmentId,
          entityType: "SHIPMENT_FULFILLMENT",
          message: `极风推单已失败 ${claimed.attemptNumber} 次，请检查配置或在后台重试。`,
          now,
          severity: "ERROR",
          title: "极风推单连续失败",
          type: "JIFENG_SUBMIT_FAILED",
        });
      }
      return true;
    });

    if (!persisted) return { status: "STALE" as const };
    return {
      status: requiresReconciliation ? ("RETRY_SCHEDULED" as const) : ("FAILED" as const),
    };
  }
}

export async function processDueJifengCreateOrderEvents(input: {
  client: JifengCreateOrderPort;
  config: DispatchConfig;
  limit?: number;
  now?: Date;
}) {
  const limit = input.limit ?? 50;
  const now = input.now ?? new Date();
  const staleLeaseCutoff = new Date(
    now.getTime() - JIFENG_RECONCILIATION_LEASE_MS,
  );
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("极风任务批量大小必须在 1 到 200 之间");
  }
  const dueEvents = await db.execute<{ id: string }>(sql`
    select id
    from integration_outbox
    where target = 'JIFENG'
      and event_type = 'JIFENG_CREATE_ORDER'
      and (
        (status in ('PENDING', 'FAILED')
          and next_attempt_at <= ${now.toISOString()}::timestamptz)
        or (status = 'PROCESSING'
          and locked_at is not null
          and locked_at <= ${staleLeaseCutoff.toISOString()}::timestamptz)
      )
    order by coalesce(locked_at, next_attempt_at), id
    limit ${limit}
  `);

  const summary = { completed: 0, failed: 0, retryScheduled: 0 };
  for (const event of dueEvents) {
    const result = await processJifengCreateOrderEvent({
      client: input.client,
      config: input.config,
      eventId: event.id,
      now,
    });
    if (
      result.status === "COMPLETED" ||
      result.status === "ALREADY_COMPLETED" ||
      result.status === "RECONCILED"
    ) {
      summary.completed += 1;
    } else if (result.status === "RETRY_SCHEDULED") {
      summary.retryScheduled += 1;
    } else if (
      result.status === "FAILED" ||
      result.status === "RECONCILIATION_REQUIRED"
    ) {
      summary.failed += 1;
    }
  }
  return summary;
}

export async function retryJifengShipment(input: {
  actorUserId: string;
  now?: Date;
  reason: string;
  shipmentId: string;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new Error("重试极风履约必须填写原因");
  const now = input.now ?? new Date();
  const references = await db.execute<{ orderId: string }>(sql`
    select order_id as "orderId" from order_shipments where id = ${input.shipmentId}
  `);
  const reference = references[0];
  if (!reference) throw new Error("Jifeng shipment not found");
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select id from fulfillment_orders where id = ${reference.orderId} for update
    `);
    const rows = await tx.execute<{
      fulfillmentId: string;
      lastErrorCode: string | null;
      orderId: string;
      replacementRequestId: string | null;
      status: string;
    }>(sql`
      select
        f.id as "fulfillmentId",
        f.last_error_code as "lastErrorCode",
        f.status,
        s.order_id as "orderId",
        r.id as "replacementRequestId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      left join replacement_requests r on r.replacement_shipment_id = s.id
      where s.id = ${input.shipmentId}
      for update of f
    `);
    const fulfillment = rows[0];
    if (!fulfillment) throw new Error("未找到极风履约包裹");
    if (["SHIPPED", "CANCELLED"].includes(fulfillment.status)) {
      throw new Error("已发货或已取消包裹不能重试");
    }
    if (fulfillment.status !== "EXCEPTION") {
      throw new Error("Only failed Jifeng fulfillments can be retried");
    }
    const eventRows = await tx.execute<{
      claimToken: string | null;
      id: string;
      lastErrorCode: string | null;
      lockedAt: Date | string | null;
      status: string;
    }>(sql`
      select
        claim_token as "claimToken",
        id,
        last_error_code as "lastErrorCode",
        locked_at as "lockedAt",
        status
      from integration_outbox
      where aggregate_id = ${input.shipmentId}
        and event_type = 'JIFENG_CREATE_ORDER'
      for update
    `);
    const event = eventRows[0];
    if (!event) throw new Error("Jifeng create event not found");
    if (
      event.status === "PROCESSING" &&
      !reconciliationLeaseExpired(event.lockedAt, now)
    ) {
      throw new JifengDispatchError(
        "RECONCILIATION_IN_PROGRESS",
        "Jifeng reconciliation is already in progress",
      );
    }
    const priorErrorCode = event.status === "PROCESSING"
      ? event.lastErrorCode ?? fulfillment.lastErrorCode ?? "STALE_PROCESSING"
      : event.lastErrorCode ?? fulfillment.lastErrorCode;
    const reconciliationPending = priorErrorCode?.startsWith(
      `${RECONCILIATION_REQUIRED}:`,
    ) === true;
    const ambiguous =
      reconciliationPending ||
      ["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE", "INTERNAL_ERROR", "STALE_PROCESSING", "50019", "50038"].includes(
        priorErrorCode ?? "",
      ) ||
      priorErrorCode?.startsWith("HTTP_") === true;
    const retryMarker = ambiguous ? priorErrorCode : MANUAL_CONFIRMED_RETRY;
    await tx
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: retryMarker,
        lastErrorMessage: ambiguous
          ? "Jifeng order outcome requires reconciliation"
          : null,
        nextRetryAt: now,
        status: ambiguous ? "EXCEPTION" : "PENDING",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, fulfillment.fulfillmentId));
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        lastErrorCode: retryMarker,
        lastErrorMessage: ambiguous
          ? "Jifeng order outcome requires reconciliation"
          : null,
        lockedAt: null,
        nextAttemptAt: now,
        status: "FAILED",
        updatedAt: now,
      })
      .where(
        and(
          eq(integrationOutbox.aggregateId, input.shipmentId),
          eq(integrationOutbox.eventType, "JIFENG_CREATE_ORDER"),
        ),
      );
    if (!fulfillment.replacementRequestId) {
      await refreshParentFulfillmentStatus(tx, {
        now,
        orderId: fulfillment.orderId,
      });
    }
    await tx
      .update(replacementRequests)
      .set({ status: "PENDING_FULFILLMENT", updatedAt: now })
      .where(eq(replacementRequests.replacementShipmentId, input.shipmentId));
    await tx.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_RETRY_REQUESTED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: { status: "PENDING" },
      beforeJson: { status: fulfillment.status },
      entityId: input.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason,
    });
    return { status: "PENDING" as const };
  });
}
