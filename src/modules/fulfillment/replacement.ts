import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  integrationOutbox,
  inventoryReservations,
  orderLines,
  orderShipments,
  replacementRequests,
  shipmentFulfillments,
} from "@/db/schema";
import { JifengApiError } from "@/integrations/jifeng/client";
import { reserveInventory } from "@/modules/inventory/service";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { createSystemNotification } from "@/modules/notifications/service";
import {
  assertSettlementAllowsPackageCancellation,
  prepareSettlementForPackageCancellation,
} from "@/modules/settlement/batch-service";

import { isJifengMatchLeaseExpired } from "./jifeng-match-lease";
import { refreshParentFulfillmentStatus } from "./order-rollup";
import { recordPackageCancellationAdjustment } from "./package-cancellation-adjustment";

export class ReplacementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplacementError";
  }
}

export type JifengCancelOrderPort = {
  cancelOrder(input: { deleteRecord?: boolean; erpNo: string }): Promise<{
    data: unknown;
    requestId?: string;
  }>;
};

function validateItems(items: Array<{ quantity: number; skuId: string }>) {
  if (items.length === 0) {
    throw new ReplacementError("ITEMS_REQUIRED", "补发必须至少选择一个 SKU");
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.skuId || seen.has(item.skuId)) {
      throw new ReplacementError("INVALID_ITEMS", "补发 SKU 不能重复或为空");
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ReplacementError("INVALID_QUANTITY", "补发数量必须是正整数");
    }
    seen.add(item.skuId);
  }
}

export async function createReplacementRequest(input: {
  actorUserId: string;
  adminUserId: string;
  items: Array<{ quantity: number; skuId: string }>;
  now?: Date;
  originalShipmentId: string;
  reason: string;
}) {
  validateItems(input.items);
  const reason = input.reason.trim();
  if (!reason) {
    throw new ReplacementError("REASON_REQUIRED", "补发必须填写原因");
  }
  if (reason.length > 1000) {
    throw new ReplacementError("REASON_TOO_LONG", "补发原因不能超过 1000 个字符");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const originalRows = await tx.execute<{
      countryCode: string;
      fulfillmentStatus: string | null;
      orderId: string;
      recipientPayloadEncrypted: string;
      storeId: string;
    }>(sql`
      select
        s.order_id as "orderId",
        s.store_id as "storeId",
        s.recipient_payload_encrypted as "recipientPayloadEncrypted",
        s.country_code as "countryCode",
        f.status as "fulfillmentStatus"
      from order_shipments s
      inner join shipment_fulfillments f on f.shipment_id = s.id
      where s.id = ${input.originalShipmentId}
        and s.kind = 'NORMAL'
      for update of s, f
    `);
    const original = originalRows[0];
    if (!original) {
      throw new ReplacementError("ORIGINAL_NOT_FOUND", "未找到原始发货包裹");
    }
    if (original.fulfillmentStatus !== "SHIPPED") {
      throw new ReplacementError("ORIGINAL_NOT_SHIPPED", "只能对已发货包裹创建补发");
    }

    const originalLines = await tx.execute<{
      quantity: number;
      skuCode: string;
      skuId: string;
      skuName: string;
    }>(sql`
      select
        sku_id as "skuId",
        max(sku_code_snapshot) as "skuCode",
        max(sku_name_snapshot) as "skuName",
        sum(quantity)::int as quantity
      from order_lines
      where shipment_id = ${input.originalShipmentId}
        and line_kind = 'SYSTEM_SKU'
        and sku_id is not null
      group by sku_id
    `);
    const originalBySku = new Map(originalLines.map((line) => [line.skuId, line]));
    for (const item of input.items) {
      const originalLine = originalBySku.get(item.skuId);
      if (!originalLine || item.quantity > originalLine.quantity) {
        throw new ReplacementError(
          "QUANTITY_EXCEEDS_ORIGINAL",
          "补发 SKU 和数量必须在原包裹商品范围内",
        );
      }
    }

    const replacementRequestId = randomUUID();
    const replacementShipmentId = randomUUID();
    for (const item of input.items) {
      await reserveInventory(tx, {
        quantity: item.quantity,
        referenceId: replacementRequestId,
        referenceType: "REPLACEMENT_REQUEST",
        skuId: item.skuId,
      });
    }
    await tx.insert(orderShipments).values({
      countryCode: original.countryCode,
      externalOrderNo: `REPL-${replacementRequestId.replaceAll("-", "")}`,
      id: replacementShipmentId,
      kind: "REPLACEMENT",
      orderId: original.orderId,
      recipientPayloadEncrypted: original.recipientPayloadEncrypted,
      shippingFeeFen: 0,
      storeId: original.storeId,
    });
    await tx.insert(orderLines).values(
      input.items.map((item) => {
        const originalLine = originalBySku.get(item.skuId)!;
        return {
          lineAmountFen: 0,
          orderId: original.orderId,
          quantity: item.quantity,
          shipmentId: replacementShipmentId,
          skuCodeSnapshot: originalLine.skuCode,
          skuId: item.skuId,
          skuNameSnapshot: originalLine.skuName,
          storeId: original.storeId,
          unitPriceFen: 0,
        };
      }),
    );
    await tx.insert(replacementRequests).values({
      createdByAdminUserId: input.adminUserId,
      id: replacementRequestId,
      orderId: original.orderId,
      originalShipmentId: input.originalShipmentId,
      reason,
      replacementShipmentId,
    });
    await tx.insert(shipmentFulfillments).values({
      erpNo: `TZX-${replacementShipmentId.replaceAll("-", "")}`,
      shipmentId: replacementShipmentId,
    });
    await tx.insert(integrationOutbox).values({
      aggregateId: replacementShipmentId,
      aggregateType: "SHIPMENT",
      eventType: "JIFENG_CREATE_ORDER",
      idempotencyKey: `jifeng:create:${replacementShipmentId}`,
      nextAttemptAt: now,
      payload: { shipmentId: replacementShipmentId },
      target: "JIFENG",
    });
    await tx.insert(auditLogs).values({
      action: "REPLACEMENT_CREATED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {
        itemCount: input.items.length,
        platformOrderNo: `REPL-${replacementRequestId.replaceAll("-", "")}`,
        replacementRequestId,
        replacementShipmentId,
      },
      beforeJson: { originalShipmentId: input.originalShipmentId },
      entityId: replacementRequestId,
      entityType: "REPLACEMENT_REQUEST",
      reason,
    });
    await enqueueCargoSyncEvent(tx, {
      idempotencyKey: `replacement-created:${replacementRequestId}`,
      now,
      reason: "replacement-inventory-reserved",
    });
    await createSystemNotification(tx, {
      deduplicationKey: `replacement-created:${replacementRequestId}`,
      entityId: replacementRequestId,
      entityType: "REPLACEMENT_REQUEST",
      message: `补发单已创建，包含 ${input.items.length} 个 SKU；系统将等待极风出现平台订单号 REPL-${replacementRequestId.replaceAll("-", "")} 后自动匹配。`,
      now,
      severity: "INFO",
      title: "补发单已创建",
      type: "REPLACEMENT_CREATED",
    });
    return { replacementRequestId, replacementShipmentId };
  });
}

function safeCancellationFailure(error: unknown) {
  if (error instanceof JifengApiError) {
    return { code: error.code.slice(0, 80), message: error.message.slice(0, 500) };
  }
  return { code: "CANCEL_FAILED", message: "极风取消请求失败" };
}

type ShipmentCancellationClaim = {
  erpNo: string;
  fulfillmentId: string;
  kind: string;
  orderId: string;
  replacementRequestId: string | null;
  status: string;
};

async function finalizeShipmentCancellation(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    claim: ShipmentCancellationClaim;
    localOnly: boolean;
    now: Date;
    reason: string;
    shipmentId: string;
  },
) {
  const quantities = await tx.execute<{ quantity: number; skuId: string }>(sql`
    select sku_id as "skuId", sum(quantity)::int as quantity
    from order_lines
    where shipment_id = ${input.shipmentId}
      and line_kind = 'SYSTEM_SKU'
      and sku_id is not null
    group by sku_id
    order by sku_id
  `);
  const referenceType = input.claim.replacementRequestId
    ? "REPLACEMENT_REQUEST"
    : "FULFILLMENT_ORDER";
  const referenceId = input.claim.replacementRequestId ?? input.claim.orderId;
  for (const item of quantities) {
    const reservationRows = await tx.execute<{ id: string; quantity: number }>(sql`
      select id, quantity
      from inventory_reservations
      where reference_type = ${referenceType}
        and reference_id = ${referenceId}
        and sku_id = ${item.skuId}
        and status = 'ACTIVE'
      for update
    `);
    const reservation = reservationRows[0];
    if (!reservation || reservation.quantity < item.quantity) {
      throw new ReplacementError(
        "RESERVATION_MISMATCH",
        "取消包裹缺少足额库存锁定，请人工核查",
      );
    }
    if (reservation.quantity === item.quantity) {
      await tx
        .update(inventoryReservations)
        .set({
          expiresAt: null,
          releaseReason: input.localOnly
            ? `本地包裹取消：${input.reason}`
            : `极风取消确认：${input.reason}`,
          status: "RELEASED",
          updatedAt: input.now,
        })
        .where(eq(inventoryReservations.id, reservation.id));
    } else {
      await tx
        .update(inventoryReservations)
        .set({ quantity: reservation.quantity - item.quantity, updatedAt: input.now })
        .where(eq(inventoryReservations.id, reservation.id));
    }
  }
  await tx
    .update(shipmentFulfillments)
    .set({
      cancelledAt: input.now,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextRetryAt: null,
      status: "CANCELLED",
      updatedAt: input.now,
    })
    .where(eq(shipmentFulfillments.id, input.claim.fulfillmentId));
  if (input.localOnly) {
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        completedAt: null,
        lastErrorCode: "LOCAL_CANCEL_MONITORING",
        lastErrorMessage: "Monitoring Jifeng for a late-arriving matching order",
        lockedAt: null,
        nextAttemptAt: input.now,
        status: "PENDING",
        updatedAt: input.now,
      })
      .where(sql`
        aggregate_id = ${input.shipmentId}
        and target = 'JIFENG'
        and event_type = 'JIFENG_CREATE_ORDER'
        and status in ('PENDING', 'FAILED', 'PROCESSING')
      `);
  }
  if (input.claim.replacementRequestId) {
    await tx
      .update(replacementRequests)
      .set({ status: "CANCELLED", updatedAt: input.now })
      .where(eq(replacementRequests.id, input.claim.replacementRequestId));
  } else {
    await recordPackageCancellationAdjustment(tx, {
      actorId: input.actorUserId,
      actorType: "ADMIN",
      now: input.now,
      orderId: input.claim.orderId,
      reason: input.reason,
      shipmentId: input.shipmentId,
    });
    await refreshParentFulfillmentStatus(tx, {
      now: input.now,
      orderId: input.claim.orderId,
    });
  }
  await tx.insert(auditLogs).values({
    action: input.localOnly
      ? "SHIPMENT_CANCELLED_BEFORE_SUBMISSION"
      : "JIFENG_SHIPMENT_CANCELLED",
    actorId: input.actorUserId,
    actorType: "ADMIN",
    afterJson: {
      cancellationMode: input.localOnly ? "LOCAL" : "JIFENG_CONFIRMED",
      status: "CANCELLED",
    },
    beforeJson: {
      status: input.localOnly ? input.claim.status : "CANCEL_PENDING",
    },
    entityId: input.shipmentId,
    entityType: "ORDER_SHIPMENT",
    reason: input.reason,
  });
  await enqueueCargoSyncEvent(tx, {
    idempotencyKey: `shipment-cancelled:${input.shipmentId}`,
    now: input.now,
    reason: "cancelled-shipment-inventory-released",
  });
}

export async function cancelJifengShipment(input: {
  actorUserId: string;
  client?: JifengCancelOrderPort;
  now?: Date;
  reason: string;
  shipmentId: string;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new ReplacementError("REASON_REQUIRED", "取消必须填写原因");
  if (reason.length > 1000) {
    throw new ReplacementError("REASON_TOO_LONG", "取消原因不能超过 1000 个字符");
  }
  const now = input.now ?? new Date();
  const references = await db.execute<{
    kind: string;
    orderId: string;
    status: string;
  }>(sql`
    select s.kind, s.order_id as "orderId", f.status
    from order_shipments s
    inner join shipment_fulfillments f on f.shipment_id = s.id
    where s.id = ${input.shipmentId}
  `);
  const reference = references[0];
  if (!reference) throw new ReplacementError("SHIPMENT_NOT_FOUND", "未找到极风包裹");
  if (reference.status === "SHIPPED") {
    throw new ReplacementError("ALREADY_SHIPPED", "极风已发货包裹不能取消");
  }
  if (reference.status === "CANCELLED") {
    return { status: "ALREADY_CANCELLED" as const };
  }
  const claimed = await db.transaction(async (tx) => {
    if (reference.kind === "NORMAL") {
      await assertSettlementAllowsPackageCancellation(tx, reference.orderId);
    }
    await tx.execute(sql`
      select id
      from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const rows = await tx.execute<{
      attemptCount: number;
      erpNo: string;
      externalOrderNo: string | null;
      fulfillmentId: string;
      jifengStatus: number | null;
      kind: string;
      orderId: string;
      replacementRequestId: string | null;
      status: string;
      submittedAt: Date | string | null;
    }>(sql`
      select
        f.attempt_count as "attemptCount",
        f.id as "fulfillmentId",
        f.erp_no as "erpNo",
        f.external_order_no as "externalOrderNo",
        f.jifeng_status as "jifengStatus",
        f.status,
        f.submitted_at as "submittedAt",
        s.kind,
        s.order_id as "orderId",
        r.id as "replacementRequestId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      left join replacement_requests r on r.replacement_shipment_id = s.id
      where s.id = ${input.shipmentId}
      for update of f, s
    `);
    const row = rows[0];
    if (!row) throw new ReplacementError("SHIPMENT_NOT_FOUND", "未找到极风包裹");
    if (row.status === "SHIPPED") {
      throw new ReplacementError("ALREADY_SHIPPED", "极风已发货包裹不能取消");
    }
    if (row.status === "CANCELLED") {
      return { ...row, alreadyCancelled: true, completedLocally: false };
    }
    if (row.status === "CANCEL_PENDING") {
      throw new ReplacementError(
        "CANCELLATION_IN_PROGRESS",
        "该包裹正在等待极风确认取消，请勿重复提交",
      );
    }
    const outboxRows = await tx.execute<{
      attemptCount: number;
      lockedAt: Date | string | null;
      status: string;
    }>(sql`
      select attempt_count as "attemptCount", locked_at as "lockedAt", status
      from integration_outbox
      where aggregate_id = ${input.shipmentId}
        and target = 'JIFENG'
        and event_type = 'JIFENG_CREATE_ORDER'
      for update
    `);
    const outbox = outboxRows[0];
    const staleMatch =
      outbox?.status === "PROCESSING" &&
      isJifengMatchLeaseExpired(outbox.lockedAt, now);
    if (outbox?.status === "PROCESSING" && !staleMatch) {
      throw new ReplacementError(
        "FULFILLMENT_SUBMISSION_IN_PROGRESS",
        "该包裹正在匹配极风订单，请等待本次查询结束后再取消",
      );
    }
    const localOnly =
      (["PENDING", "EXCEPTION"].includes(row.status) || staleMatch) &&
      row.externalOrderNo === null &&
      row.jifengStatus === null &&
      row.submittedAt === null;
    if (localOnly) {
      if (!row.replacementRequestId) {
        await prepareSettlementForPackageCancellation(tx, {
          actorId: input.actorUserId,
          actorType: "ADMIN",
          now,
          orderId: row.orderId,
          reason,
        });
      }
      await finalizeShipmentCancellation(tx, {
        actorUserId: input.actorUserId,
        claim: row,
        localOnly: true,
        now,
        reason,
        shipmentId: input.shipmentId,
      });
      return { ...row, alreadyCancelled: false, completedLocally: true };
    }
    if (!input.client) {
      throw new ReplacementError(
        "JIFENG_CLIENT_REQUIRED",
        "该包裹已绑定极风订单，取消前必须连接极风确认远端状态",
      );
    }
    await tx
      .update(shipmentFulfillments)
      .set({ status: "CANCEL_PENDING", updatedAt: now })
      .where(eq(shipmentFulfillments.id, row.fulfillmentId));
    if (row.replacementRequestId) {
      await tx
        .update(replacementRequests)
        .set({ status: "CANCEL_PENDING", updatedAt: now })
        .where(eq(replacementRequests.id, row.replacementRequestId));
    }
    return { ...row, alreadyCancelled: false, completedLocally: false };
  });
  if (claimed.alreadyCancelled) return { status: "ALREADY_CANCELLED" as const };
  if (claimed.completedLocally) return { status: "CANCELLED" as const };

  try {
    await input.client!.cancelOrder({ deleteRecord: false, erpNo: claimed.erpNo });
  } catch (error) {
    const failure = safeCancellationFailure(error);
    const terminalStatus = await db.transaction(async (tx) => {
      if (!claimed.replacementRequestId) {
        await tx.execute(sql`
          select id
          from fulfillment_orders
          where id = ${claimed.orderId}
          for update
        `);
      }
      const statusRows = await tx.execute<{ status: string }>(sql`
        select status
        from shipment_fulfillments
        where id = ${claimed.fulfillmentId}
        for update
      `);
      const currentStatus = statusRows[0]?.status;
      if (currentStatus === "CANCELLED" || currentStatus === "SHIPPED") {
        return currentStatus;
      }
      await tx
        .update(shipmentFulfillments)
        .set({
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
      if (claimed.replacementRequestId) {
        await tx
          .update(replacementRequests)
          .set({ status: "EXCEPTION", updatedAt: now })
          .where(eq(replacementRequests.id, claimed.replacementRequestId));
      } else {
        await refreshParentFulfillmentStatus(tx, {
          now,
          orderId: claimed.orderId,
        });
      }
      await tx.insert(auditLogs).values({
        action: "JIFENG_SHIPMENT_CANCEL_FAILED",
        actorId: input.actorUserId,
        actorType: "ADMIN",
        afterJson: { errorCode: failure.code, status: "EXCEPTION" },
        beforeJson: { status: "CANCEL_PENDING" },
        entityId: input.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason,
      });
      return null;
    });
    if (terminalStatus === "CANCELLED") {
      return { status: "ALREADY_CANCELLED" as const };
    }
    if (terminalStatus === "SHIPPED") {
      throw new ReplacementError(
        "SHIPPED_DURING_CANCEL",
        "取消期间极风已发货，系统未释放库存，请人工核查",
      );
    }
    throw error;
  }

  return db.transaction(async (tx) => {
    if (!claimed.replacementRequestId) {
      await prepareSettlementForPackageCancellation(tx, {
        actorId: input.actorUserId,
        actorType: "ADMIN",
        now,
        orderId: claimed.orderId,
        reason,
      });
      await tx.execute(sql`
        select id
        from fulfillment_orders
        where id = ${claimed.orderId}
        for update
      `);
    }
    const statusRows = await tx.execute<{ status: string }>(sql`
      select status
      from shipment_fulfillments
      where id = ${claimed.fulfillmentId}
      for update
    `);
    if (statusRows[0]?.status === "SHIPPED") {
      throw new ReplacementError(
        "SHIPPED_DURING_CANCEL",
        "取消期间极风已发货，系统未释放库存，请人工核查",
      );
    }
    if (statusRows[0]?.status === "CANCELLED") {
      return { status: "ALREADY_CANCELLED" as const };
    }
    await tx
      .update(shipmentFulfillments)
      .set({
        lastErrorCode: null,
        lastErrorMessage: null,
        nextRetryAt: now,
        status: "CANCEL_PENDING",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
    if (claimed.replacementRequestId) {
      await tx
        .update(replacementRequests)
        .set({ status: "CANCEL_PENDING", updatedAt: now })
        .where(eq(replacementRequests.id, claimed.replacementRequestId));
    }
    await tx.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_CANCEL_REQUESTED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: { status: "CANCEL_PENDING" },
      beforeJson: { status: claimed.status },
      entityId: input.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason,
    });
    return { status: "CANCEL_PENDING" as const };
  });
}
