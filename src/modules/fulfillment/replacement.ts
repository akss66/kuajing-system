import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
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
      message: `补发单已创建，包含 ${input.items.length} 个 SKU，等待极风履约。`,
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

export async function cancelJifengShipment(input: {
  actorUserId: string;
  client: JifengCancelOrderPort;
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
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      erpNo: string;
      fulfillmentId: string;
      kind: string;
      orderId: string;
      replacementRequestId: string | null;
      status: string;
    }>(sql`
      select
        f.id as "fulfillmentId",
        f.erp_no as "erpNo",
        f.status,
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
    if (row.status === "CANCELLED") return { ...row, alreadyCancelled: true };
    await tx
      .update(shipmentFulfillments)
      .set({ status: "CANCEL_PENDING", updatedAt: now })
      .where(eq(shipmentFulfillments.id, row.fulfillmentId));
    return { ...row, alreadyCancelled: false };
  });
  if (claimed.alreadyCancelled) return { status: "ALREADY_CANCELLED" as const };

  try {
    await input.client.cancelOrder({ deleteRecord: false, erpNo: claimed.erpNo });
  } catch (error) {
    const failure = safeCancellationFailure(error);
    await db.transaction(async (tx) => {
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
    });
    throw error;
  }

  return db.transaction(async (tx) => {
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
    const quantities = await tx.execute<{ quantity: number; skuId: string }>(sql`
      select sku_id as "skuId", sum(quantity)::int as quantity
      from order_lines
      where shipment_id = ${input.shipmentId}
      group by sku_id
      order by sku_id
    `);
    const referenceType = claimed.replacementRequestId
      ? "REPLACEMENT_REQUEST"
      : "FULFILLMENT_ORDER";
    const referenceId = claimed.replacementRequestId ?? claimed.orderId;
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
            releaseReason: `极风取消确认：${reason}`,
            status: "RELEASED",
            updatedAt: now,
          })
          .where(eq(inventoryReservations.id, reservation.id));
      } else {
        await tx
          .update(inventoryReservations)
          .set({ quantity: reservation.quantity - item.quantity, updatedAt: now })
          .where(eq(inventoryReservations.id, reservation.id));
      }
    }
    await tx
      .update(shipmentFulfillments)
      .set({
        cancelledAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        status: "CANCELLED",
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, claimed.fulfillmentId));
    if (claimed.replacementRequestId) {
      await tx
        .update(replacementRequests)
        .set({ status: "CANCELLED", updatedAt: now })
        .where(eq(replacementRequests.id, claimed.replacementRequestId));
    } else {
      await tx
        .update(fulfillmentOrders)
        .set({
          cancelReason: reason,
          status: "FULFILLMENT_EXCEPTION",
          updatedAt: now,
        })
        .where(eq(fulfillmentOrders.id, claimed.orderId));
    }
    await tx.insert(auditLogs).values({
      action: "JIFENG_SHIPMENT_CANCELLED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: { status: "CANCELLED" },
      beforeJson: { status: "CANCEL_PENDING" },
      entityId: input.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason,
    });
    await enqueueCargoSyncEvent(tx, {
      idempotencyKey: `shipment-cancelled:${input.shipmentId}`,
      now,
      reason: "cancelled-shipment-inventory-released",
    });
    return { status: "CANCELLED" as const };
  });
}
