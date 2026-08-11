import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
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
import type { JifengCreateOrderInput } from "@/integrations/jifeng/types";
import { decryptPii } from "@/shared/pii-crypto";
import { createSystemNotification } from "@/modules/notifications/service";

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
};

type DispatchConfig = {
  logisticsId: number;
  warehouseCode: string;
};

type ClaimedEvent = {
  attemptNumber: number;
  fulfillmentId: string;
  orderId: string;
  shipmentId: string;
  startedAt: Date;
};

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
  return db.transaction(async (tx): Promise<ClaimedEvent | "COMPLETED" | "BUSY"> => {
    const rows = await tx.execute<{
      attemptCount: number;
      fulfillmentId: string;
      orderId: string;
      shipmentId: string;
      status: string;
    }>(sql`
      select
        e.status,
        e.attempt_count as "attemptCount",
        f.id as "fulfillmentId",
        s.id as "shipmentId",
        s.order_id as "orderId"
      from integration_outbox e
      inner join shipment_fulfillments f on f.shipment_id::text = e.aggregate_id
      inner join order_shipments s on s.id = f.shipment_id
      where e.id = ${eventId}
        and e.target = 'JIFENG'
        and e.event_type = 'JIFENG_CREATE_ORDER'
      for update of e, f
    `);
    const event = rows[0];
    if (!event) throw new Error("未找到极风创建订单任务");
    if (event.status === "COMPLETED") return "COMPLETED";
    if (event.status === "PROCESSING") return "BUSY";

    const attemptNumber = event.attemptCount + 1;
    await tx
      .update(integrationOutbox)
      .set({
        attemptCount: attemptNumber,
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

export async function processJifengCreateOrderEvent(input: {
  client: JifengCreateOrderPort;
  config: DispatchConfig;
  eventId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const claimed = await claimEvent(input.eventId, now);
  if (claimed === "COMPLETED") return { status: "ALREADY_COMPLETED" as const };
  if (claimed === "BUSY") return { status: "BUSY" as const };

  try {
    const request = await buildCreateOrderInput(claimed.shipmentId, input.config);
    const response = await input.client.createOrder(request);

    await db.transaction(async (tx) => {
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          status: "SUBMITTED",
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
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
        .where(eq(integrationOutbox.id, input.eventId));
      await tx
        .update(fulfillmentOrders)
        .set({ status: "FULFILLING", updatedAt: now })
        .where(
          and(
            eq(fulfillmentOrders.id, claimed.orderId),
            eq(fulfillmentOrders.status, "PAID_PENDING_FULFILLMENT"),
          ),
        );
      await tx
        .update(replacementRequests)
        .set({ status: "FULFILLING", updatedAt: now })
        .where(eq(replacementRequests.replacementShipmentId, claimed.shipmentId));
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
          orderStatus: "FULFILLING",
        },
        beforeJson: {
          fulfillmentStatus: "PENDING",
          orderStatus: "PAID_PENDING_FULFILLMENT",
        },
        entityId: claimed.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: "已将包裹提交至极风履约",
      });
    });

    return { status: "COMPLETED" as const };
  } catch (error) {
    const failure = safeFailure(error);
    const nextAttemptAt = failure.retryable
      ? retryAt(now, claimed.attemptNumber)
      : new Date("9999-12-31T23:59:59.999Z");

    await db.transaction(async (tx) => {
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
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          lockedAt: null,
          nextAttemptAt,
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(integrationOutbox.id, input.eventId));
      await tx
        .update(fulfillmentOrders)
        .set({ status: "FULFILLMENT_EXCEPTION", updatedAt: now })
        .where(
          and(
            eq(fulfillmentOrders.id, claimed.orderId),
            sql`${fulfillmentOrders.status} <> 'SHIPPED'`,
          ),
        );
      await tx
        .update(replacementRequests)
        .set({ status: "EXCEPTION", updatedAt: now })
        .where(eq(replacementRequests.replacementShipmentId, claimed.shipmentId));
      await tx.insert(integrationAttempts).values({
        attemptNumber: claimed.attemptNumber,
        errorCode: failure.code,
        errorMessage: failure.message,
        finishedAt: now,
        outcome: failure.retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
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
          retryable: failure.retryable,
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
    });

    return {
      status: failure.retryable ? ("RETRY_SCHEDULED" as const) : ("FAILED" as const),
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
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("极风任务批量大小必须在 1 到 200 之间");
  }
  const dueEvents = await db.execute<{ id: string }>(sql`
    select id
    from integration_outbox
    where target = 'JIFENG'
      and event_type = 'JIFENG_CREATE_ORDER'
      and status in ('PENDING', 'FAILED')
      and next_attempt_at <= ${now.toISOString()}::timestamptz
    order by next_attempt_at, id
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
    if (result.status === "COMPLETED" || result.status === "ALREADY_COMPLETED") {
      summary.completed += 1;
    } else if (result.status === "RETRY_SCHEDULED") {
      summary.retryScheduled += 1;
    } else if (result.status === "FAILED") {
      summary.failed += 1;
    }
  }
  return summary;
}
