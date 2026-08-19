import { eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  orderShipments,
  replacementRequests,
  shipmentFulfillments,
} from "@/db/schema";
import type { JifengOrderDetail } from "@/integrations/jifeng/types";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { refreshParentFulfillmentStatus } from "@/modules/fulfillment/order-rollup";
import { inventoryReasonLabel } from "@/modules/inventory/types";
import { createSystemNotification } from "@/modules/notifications/service";

type StatusSource = "POLL" | "WEBHOOK";

export type JifengOrderStatusPort = {
  getOrder(input: { erpNo: string }): Promise<JifengOrderDetail>;
};

function parsedShippedAt(value: string | undefined, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function logisticsCurrency(value: string | undefined) {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : "CAD";
}

export async function applyJifengOrderStatus(input: {
  detail: JifengOrderDetail;
  now?: Date;
  source: StatusSource;
}, existingTx?: DbTransaction) {
  const now = input.now ?? new Date();

  const apply = async (tx: DbTransaction) => {
    const references = await tx.execute<{ orderId: string }>(sql`
      select s.order_id as "orderId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      where f.erp_no = ${input.detail.erpNo}
    `);
    const reference = references[0];
    if (!reference) throw new Error("未找到对应的极风履约包裹");
    await tx.execute(sql`
      select id
      from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const rows = await tx.execute<{
      fulfillmentCancelledAt: Date | string | null;
      fulfillmentId: string;
      fulfillmentStatus: string;
      kind: string;
      orderId: string;
      orderStatus: string;
      replacementRequestId: string | null;
      shipmentId: string;
    }>(sql`
      select
        f.cancelled_at as "fulfillmentCancelledAt",
        f.id as "fulfillmentId",
        f.status as "fulfillmentStatus",
        s.id as "shipmentId",
        s.kind,
        o.id as "orderId",
        o.status as "orderStatus",
        r.id as "replacementRequestId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      inner join fulfillment_orders o on o.id = s.order_id
      left join replacement_requests r on r.replacement_shipment_id = s.id
      where f.erp_no = ${input.detail.erpNo}
      for update of f, s
    `);
    const current = rows[0];
    if (!current) throw new Error("未找到对应的极风履约包裹");

    if (current.fulfillmentStatus === "SHIPPED" && input.detail.status === 7) {
      return {
        orderStatus: current.orderStatus as "FULFILLING" | "SHIPPED",
        status: "ALREADY_SHIPPED" as const,
      };
    }
    if (
      current.fulfillmentStatus === "CANCELLED" &&
      input.detail.status === 9 &&
      (current.replacementRequestId !== null ||
        current.orderStatus === "FULFILLMENT_EXCEPTION")
    ) {
      return {
        orderStatus: current.orderStatus,
        status: "ALREADY_CANCELLED" as const,
      };
    }

    if (input.detail.status === 7) {
      const lineQuantities = await tx.execute<{
        quantity: number;
        skuCode: string;
        skuId: string;
      }>(sql`
        select
          sku_id as "skuId",
          max(sku_code_snapshot) as "skuCode",
          sum(quantity)::int as quantity
        from order_lines
        where shipment_id = ${current.shipmentId}
        group by sku_id
        order by sku_id
      `);
      if (lineQuantities.length === 0) {
        throw new Error("极风已发货包裹没有对应的商品明细");
      }

      for (const line of lineQuantities) {
        const balanceRows = await tx.execute<{ totalQuantity: number }>(sql`
          select total_quantity as "totalQuantity"
          from inventory_balances
          where sku_id = ${line.skuId}
          for update
        `);
        const reservationType = current.replacementRequestId
          ? "REPLACEMENT_REQUEST"
          : "FULFILLMENT_ORDER";
        const reservationReferenceId =
          current.replacementRequestId ?? current.orderId;
        const reservationRows = await tx.execute<{
          id: string;
          quantity: number;
        }>(sql`
          select id, quantity
          from inventory_reservations
          where reference_type = ${reservationType}
            and reference_id = ${reservationReferenceId}
            and sku_id = ${line.skuId}
            and status = 'ACTIVE'
          for update
        `);
        const balance = balanceRows[0];
        const reservation = reservationRows[0];
        if (!balance || balance.totalQuantity < line.quantity) {
          throw new Error("极风发货扣减时库存余额不足，请人工核查");
        }
        if (!reservation || reservation.quantity < line.quantity) {
          throw new Error("极风发货包裹缺少足额库存锁定，请人工核查");
        }

        const afterQuantity = balance.totalQuantity - line.quantity;
        await tx
          .update(inventoryBalances)
          .set({ totalQuantity: afterQuantity, updatedAt: now })
          .where(eq(inventoryBalances.skuId, line.skuId));
        if (reservation.quantity === line.quantity) {
          await tx
            .update(inventoryReservations)
            .set({ expiresAt: null, status: "CONSUMED", updatedAt: now })
            .where(eq(inventoryReservations.id, reservation.id));
        } else {
          await tx
            .update(inventoryReservations)
            .set({
              quantity: reservation.quantity - line.quantity,
              updatedAt: now,
            })
            .where(eq(inventoryReservations.id, reservation.id));
        }
        await tx.insert(inventoryMovements).values({
          actorId: null,
          actorType: "SYSTEM",
          afterQuantity,
          beforeQuantity: balance.totalQuantity,
          delta: -line.quantity,
          movementType: "SHIPMENT",
          reason: inventoryReasonLabel("SYSTEM_SHIPMENT"),
          reasonCode: "SYSTEM_SHIPMENT",
          referenceId: current.shipmentId,
          referenceType: "ORDER_SHIPMENT",
          skuId: line.skuId,
        });
        if (afterQuantity < 10) {
          await createSystemNotification(tx, {
            deduplicationKey: `low-stock:${line.skuId}`,
            entityId: line.skuId,
            entityType: "SKU",
            message: `${line.skuCode} 总库存仅剩 ${afterQuantity} 件，请核对锁定量并安排补货。`,
            now,
            severity: afterQuantity === 0 ? "ERROR" : "WARNING",
            title: "低库存预警",
            type: "LOW_STOCK",
          });
        }
      }

      const shippedAt = parsedShippedAt(input.detail.shippedTime, now);
      const feeMinor =
        input.detail.logisticsFee === undefined
          ? null
          : Math.round(input.detail.logisticsFee * 100);
      await tx
        .update(orderShipments)
        .set({
          logisticsCurrency:
            feeMinor === null ? null : logisticsCurrency(input.detail.currency),
          logisticsFeeMinor: feeMinor,
          shippedAt,
          trackingNumber: input.detail.trackingNo ?? null,
          updatedAt: now,
        })
        .where(eq(orderShipments.id, current.shipmentId));
      await tx
        .update(shipmentFulfillments)
        .set({
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: 7,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          shippedAt,
          status: "SHIPPED",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      if (current.replacementRequestId) {
        await tx
          .update(replacementRequests)
          .set({ status: "SHIPPED", updatedAt: now })
          .where(eq(replacementRequests.id, current.replacementRequestId));
      }

      const orderStatus = current.replacementRequestId
        ? current.orderStatus
        : await refreshParentFulfillmentStatus(tx, {
            now,
            orderId: current.orderId,
          });
      await tx.insert(auditLogs).values({
        action: "JIFENG_SHIPMENT_SHIPPED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          fulfillmentStatus: "SHIPPED",
          jifengStatus: 7,
          orderStatus,
          source: input.source,
        },
        beforeJson: {
          fulfillmentStatus: current.fulfillmentStatus,
          orderStatus: current.orderStatus,
        },
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "极风确认包裹已发货，已正式扣减库存",
      });
      await enqueueCargoSyncEvent(tx, {
        idempotencyKey: `shipment-shipped:${current.shipmentId}`,
        now,
        reason: "shipment-inventory-consumed",
      });
      if (current.replacementRequestId) {
        await createSystemNotification(tx, {
          deduplicationKey: `replacement-shipped:${current.replacementRequestId}`,
          entityId: current.replacementRequestId,
          entityType: "REPLACEMENT_REQUEST",
          message: "补发包裹已由极风确认发货，可在系统订单详情查看运单。",
          now,
          severity: "INFO",
          title: "补发仓库已发货",
          type: "REPLACEMENT_SHIPPED",
        });
      }
      return { orderStatus, status: "SHIPPED" as const };
    }

    if (input.detail.status === 8 || input.detail.status === 11) {
      await tx
        .update(shipmentFulfillments)
        .set({
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: input.detail.status,
          lastErrorCode: String(input.detail.errorCode ?? input.detail.status),
          lastErrorMessage: "极风报告仓库处理异常，请在极风后台核查",
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      if (current.replacementRequestId) {
        await tx
          .update(replacementRequests)
          .set({ status: "EXCEPTION", updatedAt: now })
          .where(eq(replacementRequests.id, current.replacementRequestId));
      }
      const orderStatus = current.replacementRequestId
        ? current.orderStatus
        : await refreshParentFulfillmentStatus(tx, {
            now,
            orderId: current.orderId,
          });
      await tx.insert(auditLogs).values({
        action: "JIFENG_FULFILLMENT_EXCEPTION",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          errorCode: input.detail.errorCode ?? null,
          jifengStatus: input.detail.status,
          orderStatus,
          source: input.source,
        },
        beforeJson: {
          fulfillmentStatus: current.fulfillmentStatus,
          orderStatus: current.orderStatus,
        },
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "极风返回仓库处理异常状态",
      });
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-exception:${current.fulfillmentId}:${input.detail.status}`,
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: `极风包裹状态异常（状态码 ${input.detail.status}），请进入订单详情处理。`,
        now,
        severity: "ERROR",
        title: "极风仓库处理异常",
        type: "JIFENG_EXCEPTION",
      });
      return { orderStatus, status: "EXCEPTION" as const };
    }

    if (input.detail.status === 9) {
      const quantities = await tx.execute<{ quantity: number; skuId: string }>(sql`
        select sku_id as "skuId", sum(quantity)::int as quantity
        from order_lines
        where shipment_id = ${current.shipmentId}
        group by sku_id
        order by sku_id
      `);
      const referenceType = current.replacementRequestId
        ? "REPLACEMENT_REQUEST"
        : "FULFILLMENT_ORDER";
      const referenceId = current.replacementRequestId ?? current.orderId;
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
          throw new Error("极风取消包裹缺少足额库存锁定，请人工核查");
        }
        if (reservation.quantity === item.quantity) {
          await tx
            .update(inventoryReservations)
            .set({
              expiresAt: null,
              releaseReason: "极风状态同步确认包裹已取消",
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
          cancelledAt: current.fulfillmentCancelledAt
            ? new Date(current.fulfillmentCancelledAt)
            : now,
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: 9,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          status: "CANCELLED",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));

      if (current.replacementRequestId) {
        await tx
          .update(replacementRequests)
          .set({ status: "CANCELLED", updatedAt: now })
          .where(eq(replacementRequests.id, current.replacementRequestId));
      }
      const orderStatus = current.replacementRequestId
        ? current.orderStatus
        : await refreshParentFulfillmentStatus(tx, {
            now,
            orderId: current.orderId,
          });
      await tx.insert(auditLogs).values({
        action: "JIFENG_SHIPMENT_CANCELLED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          fulfillmentStatus: "CANCELLED",
          jifengStatus: 9,
          orderStatus,
          source: input.source,
        },
        beforeJson: {
          fulfillmentStatus: current.fulfillmentStatus,
          orderStatus: current.orderStatus,
        },
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "极风状态同步确认包裹已取消",
      });
      await enqueueCargoSyncEvent(tx, {
        idempotencyKey: `shipment-cancelled:${current.shipmentId}`,
        now,
        reason: "cancelled-shipment-inventory-released",
      });
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-cancelled:${current.fulfillmentId}`,
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: "极风已取消包裹，系统已释放对应库存锁定，请进入订单详情处理。",
        now,
        severity: "WARNING",
        title: "极风包裹已取消",
        type: "JIFENG_EXCEPTION",
      });
      return { orderStatus, status: "CANCELLED" as const };
    }

    const status = "FULFILLING";
    await tx
      .update(shipmentFulfillments)
      .set({
        cancelledAt: null,
        externalOrderNo: input.detail.orderNo ?? null,
        jifengStatus: input.detail.status,
        lastErrorCode: null,
        lastErrorMessage: null,
        status,
        updatedAt: now,
      })
      .where(eq(shipmentFulfillments.id, current.fulfillmentId));
    if (current.replacementRequestId) {
      await tx
        .update(replacementRequests)
        .set({
          status: "FULFILLING",
          updatedAt: now,
        })
        .where(eq(replacementRequests.id, current.replacementRequestId));
    }
    const orderStatus = current.replacementRequestId
      ? current.orderStatus
      : await refreshParentFulfillmentStatus(tx, {
          now,
          orderId: current.orderId,
        });
    return {
      orderStatus,
      status,
    };
  };
  return existingTx ? apply(existingTx) : db.transaction(apply);
}

export async function pollActiveJifengFulfillments(input: {
  client: JifengOrderStatusPort;
  limit?: number;
  now?: Date;
}) {
  const limit = input.limit ?? 100;
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("极风状态轮询批量大小必须在 1 到 500 之间");
  }
  const active = await db.execute<{ erpNo: string }>(sql`
    select erp_no as "erpNo"
    from shipment_fulfillments
    where status in ('SUBMITTED', 'FULFILLING', 'EXCEPTION')
      and (next_retry_at is null or next_retry_at <= ${now.toISOString()}::timestamptz)
    order by coalesce(last_attempt_at, created_at), id
    limit ${limit}
  `);
  const summary = { exceptions: 0, shipped: 0, synced: 0 };
  for (const fulfillment of active) {
    try {
      const detail = await input.client.getOrder({ erpNo: fulfillment.erpNo });
      const result = await applyJifengOrderStatus({ detail, now, source: "POLL" });
      if (result.status === "SHIPPED") summary.shipped += 1;
      else if (result.status === "EXCEPTION") summary.exceptions += 1;
      else summary.synced += 1;
    } catch {
      const nextRetryAt = new Date(now.getTime() + 5 * 60_000);
      await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          fulfillmentId: string;
          fulfillmentStatus: string;
        }>(sql`
          select
            f.id as "fulfillmentId",
            f.status as "fulfillmentStatus"
          from shipment_fulfillments f
          where f.erp_no = ${fulfillment.erpNo}
          for update of f
        `);
        const row = locked[0];
        if (!row) return;
        await tx
          .update(shipmentFulfillments)
          .set({
            lastErrorCode: "STATUS_POLL_FAILED",
            lastErrorMessage: "极风状态查询失败，系统将在稍后重试",
            nextRetryAt,
            updatedAt: now,
          })
          .where(eq(shipmentFulfillments.id, row.fulfillmentId));
        await tx.insert(auditLogs).values({
          action: "JIFENG_STATUS_POLL_FAILED",
          actorId: null,
          actorType: "SYSTEM",
          afterJson: {
            errorCode: "STATUS_POLL_FAILED",
            nextRetryAt: nextRetryAt.toISOString(),
          },
          beforeJson: { fulfillmentStatus: row.fulfillmentStatus },
          entityId: row.fulfillmentId,
          entityType: "SHIPMENT_FULFILLMENT",
          reason: "极风状态查询失败，已安排重试",
        });
        await createSystemNotification(tx, {
          deduplicationKey: `jifeng-poll-failed:${row.fulfillmentId}`,
          entityId: row.fulfillmentId,
          entityType: "SHIPMENT_FULFILLMENT",
          message: "极风状态查询失败，系统已安排重试；远端订单不会因此重复创建。",
          now,
          severity: "WARNING",
          title: "极风状态查询失败",
          type: "JIFENG_POLL_FAILED",
        });
      });
      summary.exceptions += 1;
    }
  }
  return summary;
}
