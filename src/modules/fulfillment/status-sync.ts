import { and, eq, sql } from "drizzle-orm";

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
import { JifengApiError } from "@/integrations/jifeng/client";
import type { JifengOrderDetail } from "@/integrations/jifeng/types";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { refreshParentFulfillmentStatus } from "@/modules/fulfillment/order-rollup";
import { inventoryReasonLabel } from "@/modules/inventory/types";
import {
  createSystemNotification,
  resolveSystemNotifications,
} from "@/modules/notifications/service";
import {
  recordPackageCancellationAdjustment,
} from "@/modules/fulfillment/package-cancellation-adjustment";
import { prepareSettlementForConfirmedRemoteCancellation } from "@/modules/settlement/batch-service";

type StatusSource = "MANUAL" | "POLL" | "WEBHOOK";

const ACTIVE_STATUS_POLL_INTERVAL_MS = 5 * 60_000;
const EXCEPTION_STATUS_POLL_INTERVAL_MS = 30 * 60_000;
const SHIPPED_METADATA_POLL_INTERVAL_MS = 6 * 60 * 60_000;
const STATUS_POLL_LEASE_MS = 2 * 60_000;
const STATUS_POLL_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const STATUS_POLL_WARNING_THRESHOLD = 3;
const STATUS_POLL_NEVER_RETRY_AT = new Date("9999-12-31T23:59:59.999Z");
const CANCEL_CONFIRMATION_TIMEOUT_MS = 6 * 60 * 60_000;
const CANCEL_CONFIRMATION_TIMEOUT_CODE = "CANCEL_CONFIRMATION_TIMEOUT";
export const REMOTE_SHIP_INVENTORY_INVARIANT_CODE =
  "REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH";
const REMOTE_ACTIVE_AFTER_LOCAL_CANCEL_CODE =
  "REMOTE_ACTIVE_AFTER_LOCAL_CANCEL";
const REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE =
  "REMOTE_SHIPPED_AFTER_LOCAL_CANCEL";

export type JifengOrderStatusPort = {
  getOrder(input: { erpNo: string }): Promise<JifengOrderDetail>;
};

export class JifengStatusRefreshError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "JifengStatusRefreshError";
  }
}

function parsedRemoteShippedAt(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function logisticsCurrency(value: string | undefined) {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : "CAD";
}

export function nextJifengStatusPollAt(now: Date) {
  return new Date(now.getTime() + ACTIVE_STATUS_POLL_INTERVAL_MS);
}

function statusPollFailure(error: unknown) {
  if (error instanceof JifengApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "极风状态查询出现内部错误",
    retryable: true,
  };
}

function statusPollRetryAt(input: {
  failureCount: number;
  now: Date;
  retryable: boolean;
}) {
  if (!input.retryable) return STATUS_POLL_NEVER_RETRY_AT;
  const delayMs = Math.min(
    ACTIVE_STATUS_POLL_INTERVAL_MS * 2 ** (input.failureCount - 1),
    STATUS_POLL_MAX_BACKOFF_MS,
  );
  return new Date(input.now.getTime() + delayMs);
}

function clearedStatusPollState(input: {
  nextRetryAt: Date | null;
  now: Date;
  source: StatusSource;
}) {
  return {
    ...(input.source !== "WEBHOOK" ? { lastStatusPollAt: input.now } : {}),
    lastStatusPollErrorCode: null,
    lastStatusPollErrorMessage: null,
    nextRetryAt: input.nextRetryAt,
    statusPollClaimToken: null,
    statusPollFailureCount: 0,
    statusPollLockedAt: null,
  };
}

export class RemoteShippedInventoryInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteShippedInventoryInvariantError";
  }
}

export function isRemoteShippedInventoryInvariantFailure(error: unknown) {
  return error instanceof RemoteShippedInventoryInvariantError;
}

function cancellationConfirmationPolicy(requestedAt: Date, now: Date) {
  const elapsedMs = Math.max(0, now.getTime() - requestedAt.getTime());
  if (elapsedMs < 15 * 60_000) return { delayMs: 60_000, timedOut: false };
  if (elapsedMs < 60 * 60_000) return { delayMs: 5 * 60_000, timedOut: false };
  if (elapsedMs < CANCEL_CONFIRMATION_TIMEOUT_MS) {
    return { delayMs: 30 * 60_000, timedOut: false };
  }
  return { delayMs: 2 * 60 * 60_000, timedOut: true };
}

function shippedMetadataPollAt(input: {
  feeMinor: number | null;
  fulfillmentShippedAt: Date | null;
  now: Date;
  shipmentShippedAt: Date | null;
  trackingNumber: string | null;
}) {
  return input.feeMinor === null ||
    !input.trackingNumber?.trim() ||
    input.fulfillmentShippedAt === null ||
    input.shipmentShippedAt === null
    ? new Date(input.now.getTime() + SHIPPED_METADATA_POLL_INTERVAL_MS)
    : null;
}

async function resolveJifengExceptionIncident(
  tx: DbTransaction,
  input: {
    fulfillmentId: string;
    jifengStatus: number | null;
    now: Date;
    priorStatus: string;
  },
) {
  if (
    input.priorStatus !== "EXCEPTION" ||
    ![8, 11].includes(input.jifengStatus ?? -1)
  ) {
    return;
  }
  await resolveSystemNotifications(tx, {
    deduplicationKeys: [
      `jifeng-exception:${input.fulfillmentId}`,
      `jifeng-exception:${input.fulfillmentId}:8`,
      `jifeng-exception:${input.fulfillmentId}:11`,
    ],
    now: input.now,
  });
}

export async function applyJifengOrderStatus(input: {
  detail: JifengOrderDetail;
  now?: Date;
  source: StatusSource;
}, existingTx?: DbTransaction) {
  const now = input.now ?? new Date();

  const apply = async (tx: DbTransaction) => {
    const references = await tx.execute<{ kind: string; orderId: string }>(sql`
      select s.kind, s.order_id as "orderId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      where f.erp_no = ${input.detail.erpNo}
    `);
    const reference = references[0];
    if (!reference) throw new Error("未找到对应的极风履约包裹");
    if (input.detail.status === 9 && reference.kind === "NORMAL") {
      await prepareSettlementForConfirmedRemoteCancellation(tx, {
        now,
        orderId: reference.orderId,
        reason: "极风状态同步确认包裹已取消",
      });
    }
    await tx.execute(sql`
      select id
      from fulfillment_orders
      where id = ${reference.orderId}
      for update
    `);
    const rows = await tx.execute<{
      cancellationAdjustmentId: string | null;
      cancellationRequestedAt: Date | string | null;
      fulfillmentCancelledAt: Date | string | null;
      fulfillmentId: string;
      fulfillmentStatus: string;
      fulfillmentNextRetryAt: Date | string | null;
      fulfillmentShippedAt: Date | string | null;
      jifengStatus: number | null;
      kind: string;
      lastErrorCode: string | null;
      logisticsCurrency: string | null;
      logisticsFeeMinor: number | null;
      orderId: string;
      orderStatus: string;
      replacementRequestId: string | null;
      shipmentId: string;
      shipmentShippedAt: Date | string | null;
      trackingNumber: string | null;
    }>(sql`
      select
        adjustment.id as "cancellationAdjustmentId",
        (
          select log.created_at
          from audit_logs log
          where log.entity_type = 'ORDER_SHIPMENT'
            and log.entity_id = s.id::text
            and log.action = 'JIFENG_SHIPMENT_CANCEL_REQUESTED'
          order by log.created_at desc
          limit 1
        ) as "cancellationRequestedAt",
        f.cancelled_at as "fulfillmentCancelledAt",
        f.id as "fulfillmentId",
        f.status as "fulfillmentStatus",
        f.next_retry_at as "fulfillmentNextRetryAt",
        f.shipped_at as "fulfillmentShippedAt",
        f.jifeng_status as "jifengStatus",
        f.last_error_code as "lastErrorCode",
        s.id as "shipmentId",
        s.shipped_at as "shipmentShippedAt",
        s.kind,
        s.logistics_currency as "logisticsCurrency",
        s.logistics_fee_minor as "logisticsFeeMinor",
        s.tracking_number as "trackingNumber",
        o.id as "orderId",
        o.status as "orderStatus",
        r.id as "replacementRequestId"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      inner join fulfillment_orders o on o.id = s.order_id
      left join replacement_requests r on r.replacement_shipment_id = s.id
      left join shipment_cancellation_adjustments adjustment on adjustment.shipment_id = s.id
      where f.erp_no = ${input.detail.erpNo}
      for update of f, s
    `);
    const current = rows[0];
    if (!current) throw new Error("未找到对应的极风履约包裹");

    if (current.fulfillmentStatus === "SHIPPED") {
      const receivedShippedMetadata = input.detail.status === 7;
      const detailFeeMinor =
        receivedShippedMetadata && input.detail.logisticsFee !== undefined
          ? Math.round(input.detail.logisticsFee * 100)
          : null;
      const trackingNumber =
        current.trackingNumber?.trim() ||
        (receivedShippedMetadata ? input.detail.trackingNo?.trim() || null : null);
      const feeMinor = current.logisticsFeeMinor ?? detailFeeMinor;
      const detailShippedAt = receivedShippedMetadata
        ? parsedRemoteShippedAt(input.detail.shippedTime)
        : null;
      const fulfillmentShippedAt =
        detailShippedAt ??
        (current.fulfillmentShippedAt
          ? new Date(current.fulfillmentShippedAt)
          : null);
      const shipmentShippedAt =
        detailShippedAt ??
        (current.shipmentShippedAt ? new Date(current.shipmentShippedAt) : null);
      const nextRetryAt = shippedMetadataPollAt({
        feeMinor,
        fulfillmentShippedAt,
        now,
        shipmentShippedAt,
        trackingNumber,
      });
      if (receivedShippedMetadata) {
        await tx
          .update(orderShipments)
          .set({
            logisticsCurrency:
              current.logisticsCurrency ??
              (feeMinor === null ? null : logisticsCurrency(input.detail.currency)),
            logisticsFeeMinor: feeMinor,
            shippedAt: shipmentShippedAt,
            trackingNumber,
            updatedAt: now,
          })
          .where(eq(orderShipments.id, current.shipmentId));
      }
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt, now, source: input.source }),
          shippedAt: fulfillmentShippedAt,
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      return {
        orderStatus: current.orderStatus as "FULFILLING" | "SHIPPED",
        status: "ALREADY_SHIPPED" as const,
      };
    }
    if (
      current.fulfillmentStatus === "CANCELLED" &&
      current.jifengStatus === 9 &&
      input.detail.status !== 9
    ) {
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt: null, now, source: input.source }),
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      return {
        orderStatus: current.orderStatus,
        status: "ALREADY_CANCELLED" as const,
      };
    }
    const isLateRemoteAfterLocalCancel =
      (current.fulfillmentStatus === "CANCELLED" && current.jifengStatus !== 9) ||
      current.lastErrorCode === REMOTE_ACTIVE_AFTER_LOCAL_CANCEL_CODE ||
      current.lastErrorCode === REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE;
    if (
      isLateRemoteAfterLocalCancel &&
      input.detail.status === 7 &&
      current.lastErrorCode !== REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE
    ) {
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
        throw new RemoteShippedInventoryInvariantError(
          "本地取消后极风仍发货，但包裹没有对应商品明细",
        );
      }
      for (const line of lineQuantities) {
        const balanceRows = await tx.execute<{ totalQuantity: number }>(sql`
          select total_quantity as "totalQuantity"
          from inventory_balances
          where sku_id = ${line.skuId}
          for update
        `);
        const balance = balanceRows[0];
        if (!balance || balance.totalQuantity < line.quantity) {
          throw new RemoteShippedInventoryInvariantError(
            "本地取消后极风仍发货，但库存余额不足以完成对账",
          );
        }
        const afterQuantity = balance.totalQuantity - line.quantity;
        await tx
          .update(inventoryBalances)
          .set({ totalQuantity: afterQuantity, updatedAt: now })
          .where(eq(inventoryBalances.skuId, line.skuId));
        await tx.insert(inventoryMovements).values({
          actorId: null,
          actorType: "SYSTEM",
          afterQuantity,
          beforeQuantity: balance.totalQuantity,
          delta: -line.quantity,
          movementType: "SHIPMENT",
          reason: "本地取消后极风仍实际发货，执行库存对账扣减",
          reasonCode: "SYSTEM_SHIPMENT",
          referenceId: current.shipmentId,
          referenceType: "ORDER_SHIPMENT",
          skuId: line.skuId,
        });
      }
      const shippedAt = parsedRemoteShippedAt(input.detail.shippedTime);
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
          trackingNumber: input.detail.trackingNo?.trim() || null,
          updatedAt: now,
        })
        .where(eq(orderShipments.id, current.shipmentId));
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({
            nextRetryAt: null,
            now,
            source: input.source,
          }),
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: 7,
          lastErrorCode: REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE,
          lastErrorMessage:
            "本地取消后极风仍实际发货，库存已扣减，请人工处理资金和客户对账。",
          nextRetryAt: null,
          shippedAt,
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      await tx.insert(auditLogs).values({
        action: "JIFENG_SHIPPED_AFTER_LOCAL_CANCEL",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          errorCode: REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE,
          jifengStatus: 7,
          source: input.source,
        },
        beforeJson: {
          fulfillmentStatus: current.fulfillmentStatus,
          orderStatus: current.orderStatus,
        },
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "本地取消后极风仍发货，已扣减实际出库库存并转人工对账",
      });
      await enqueueCargoSyncEvent(tx, {
        idempotencyKey: `shipment-shipped-after-local-cancel:${current.shipmentId}`,
        now,
        reason: "remote-shipped-after-local-cancel",
      });
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-shipped-after-local-cancel:${current.fulfillmentId}`,
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message:
          "本地取消后极风仍实际发货。系统已按实际出库扣减库存并保存运单，请立即核对资金和客户处理。",
        now,
        severity: "ERROR",
        title: "本地取消后极风仍发货",
        type: "JIFENG_EXCEPTION",
      });
      return {
        orderStatus: current.orderStatus,
        status: "EXCEPTION" as const,
      };
    }
    if (
      isLateRemoteAfterLocalCancel &&
      input.detail.status === 7 &&
      current.lastErrorCode === REMOTE_SHIPPED_AFTER_LOCAL_CANCEL_CODE
    ) {
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt: null, now, source: input.source }),
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      return {
        orderStatus: current.orderStatus,
        status: "EXCEPTION" as const,
      };
    }
    if (isLateRemoteAfterLocalCancel && input.detail.status !== 9) {
      const nextRetryAt = new Date(now.getTime() + EXCEPTION_STATUS_POLL_INTERVAL_MS);
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt, now, source: input.source }),
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: input.detail.status,
          lastErrorCode: REMOTE_ACTIVE_AFTER_LOCAL_CANCEL_CODE,
          lastErrorMessage:
            "本地已取消，但极风远端订单仍在处理中；系统将继续低频跟踪到取消或发货。",
          status: "EXCEPTION",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      await tx.insert(auditLogs).values({
        action: "JIFENG_CANCELLED_REMOTE_STATUS_CONFLICT",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: {
          localStatus: current.fulfillmentStatus,
          nextRetryAt: nextRetryAt.toISOString(),
          remoteStatus: input.detail.status,
          source: input.source,
        },
        beforeJson: { localStatus: current.fulfillmentStatus },
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: "本地已取消但极风远端状态不是 9",
      });
      await createSystemNotification(tx, {
        deduplicationKey: `jifeng-cancel-conflict:${current.fulfillmentId}:${input.detail.status}`,
        entityId: current.shipmentId,
        entityType: "ORDER_SHIPMENT",
        message: `本地包裹已取消，但极风状态为 ${input.detail.status}，请立即核查是否仍会发货。`,
        now,
        severity: "ERROR",
        title: "本地取消与极风状态冲突",
        type: "JIFENG_EXCEPTION",
      });
      return {
        orderStatus: current.orderStatus,
        status: "EXCEPTION" as const,
      };
    }

    if (
      current.fulfillmentStatus === "CANCEL_PENDING" &&
      input.detail.status !== 7 &&
      input.detail.status !== 9
    ) {
      const requestedAt = current.cancellationRequestedAt
        ? new Date(current.cancellationRequestedAt)
        : current.fulfillmentNextRetryAt
          ? new Date(current.fulfillmentNextRetryAt)
          : now;
      const policy = cancellationConfirmationPolicy(requestedAt, now);
      const nextRetryAt = new Date(now.getTime() + policy.delayMs);
      const timedOutForFirstTime =
        policy.timedOut && current.lastErrorCode !== CANCEL_CONFIRMATION_TIMEOUT_CODE;
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt, now, source: input.source }),
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: input.detail.status,
          lastErrorCode: policy.timedOut
            ? CANCEL_CONFIRMATION_TIMEOUT_CODE
            : "CANCEL_CONFIRMATION_PENDING",
          lastErrorMessage: policy.timedOut
            ? "极风取消请求超过 6 小时仍未确认，系统将低频继续核对"
            : "极风已接收取消请求，等待远端状态确认",
          nextRetryAt,
          status: "CANCEL_PENDING",
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      if (timedOutForFirstTime) {
        await createSystemNotification(tx, {
          deduplicationKey: `jifeng-cancel-confirmation-timeout:${current.fulfillmentId}`,
          entityId: current.shipmentId,
          entityType: "ORDER_SHIPMENT",
          message: "极风取消请求超过 6 小时仍未确认。系统会继续低频核对，请人工检查极风后台。",
          now,
          severity: "WARNING",
          title: "极风取消确认超时",
          type: "JIFENG_CANCEL_CONFIRMATION_TIMEOUT",
        });
      }
      return {
        orderStatus: current.orderStatus,
        status: "CANCEL_PENDING" as const,
      };
    }
    if (
      current.fulfillmentStatus === "CANCELLED" &&
      input.detail.status === 9 &&
      (current.replacementRequestId !== null ||
        current.cancellationAdjustmentId !== null)
    ) {
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt: null, now, source: input.source }),
          updatedAt: now,
        })
        .where(eq(shipmentFulfillments.id, current.fulfillmentId));
      const orderStatus = current.replacementRequestId
        ? current.orderStatus
        : await refreshParentFulfillmentStatus(tx, {
            now,
            orderId: current.orderId,
          });
      return {
        orderStatus,
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
        throw new RemoteShippedInventoryInvariantError(
          "极风已发货包裹没有对应的商品明细",
        );
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
          throw new RemoteShippedInventoryInvariantError(
            "极风发货扣减时库存余额不足，请人工核查",
          );
        }
        if (!reservation || reservation.quantity < line.quantity) {
          throw new RemoteShippedInventoryInvariantError(
            "极风发货包裹缺少足额库存锁定，请人工核查",
          );
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

      const shippedAt = parsedRemoteShippedAt(input.detail.shippedTime);
      const feeMinor =
        input.detail.logisticsFee === undefined
          ? null
          : Math.round(input.detail.logisticsFee * 100);
      const nextRetryAt = shippedMetadataPollAt({
        feeMinor,
        fulfillmentShippedAt: shippedAt,
        now,
        shipmentShippedAt: shippedAt,
        trackingNumber: input.detail.trackingNo?.trim() || null,
      });
      await tx
        .update(orderShipments)
        .set({
          logisticsCurrency:
            feeMinor === null ? null : logisticsCurrency(input.detail.currency),
          logisticsFeeMinor: feeMinor,
          shippedAt,
          trackingNumber: input.detail.trackingNo?.trim() || null,
          updatedAt: now,
        })
        .where(eq(orderShipments.id, current.shipmentId));
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({ nextRetryAt, now, source: input.source }),
          externalOrderNo: input.detail.orderNo ?? null,
          jifengStatus: 7,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt,
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
      await resolveJifengExceptionIncident(tx, {
        fulfillmentId: current.fulfillmentId,
        jifengStatus: current.jifengStatus,
        now,
        priorStatus: current.fulfillmentStatus,
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
      const isNewExceptionIncident =
        current.fulfillmentStatus !== "EXCEPTION" ||
        ![8, 11].includes(current.jifengStatus ?? -1);
      await tx
        .update(shipmentFulfillments)
        .set({
          ...clearedStatusPollState({
            nextRetryAt: new Date(
              now.getTime() + EXCEPTION_STATUS_POLL_INTERVAL_MS,
            ),
            now,
            source: input.source,
          }),
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
      if (isNewExceptionIncident) {
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
          deduplicationKey: `jifeng-exception:${current.fulfillmentId}`,
          entityId: current.shipmentId,
          entityType: "ORDER_SHIPMENT",
          message: `极风包裹状态异常（状态码 ${input.detail.status}），请进入订单详情处理。`,
          now,
          severity: "ERROR",
          title: "极风仓库处理异常",
          type: "JIFENG_EXCEPTION",
        });
      }
      return { orderStatus, status: "EXCEPTION" as const };
    }

    if (input.detail.status === 9) {
      const priorCancellationRows =
        current.fulfillmentStatus === "CANCELLED" ||
        current.lastErrorCode === REMOTE_ACTIVE_AFTER_LOCAL_CANCEL_CODE
          ? await tx.execute<{ inventoryAlreadyReleased: boolean }>(sql`
              select exists (
                select 1
                from audit_logs
                where (
                  entity_type = 'ORDER_SHIPMENT'
                  and entity_id = ${current.shipmentId}
                  and action in (
                    'JIFENG_SHIPMENT_CANCELLED',
                    'SHIPMENT_CANCELLED_BEFORE_SUBMISSION'
                  )
                ) or (
                  entity_type = 'FULFILLMENT_ORDER'
                  and entity_id = ${current.orderId}
                  and action = 'FULFILLMENT_ORDER_CANCELLED'
                )
              ) as "inventoryAlreadyReleased"
            `)
          : [];
      const inventoryAlreadyReleased =
        priorCancellationRows[0]?.inventoryAlreadyReleased ?? false;
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
      for (const item of inventoryAlreadyReleased ? [] : quantities) {
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
          ...clearedStatusPollState({ nextRetryAt: null, now, source: input.source }),
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
      } else {
        await recordPackageCancellationAdjustment(tx, {
          actorId: null,
          actorType: "SYSTEM",
          financialAuthorization: "CONFIRMED_REMOTE_CANCELLATION",
          now,
          orderId: current.orderId,
          reason: "极风状态同步确认包裹已取消",
          shipmentId: current.shipmentId,
        });
      }
      const orderStatus = current.replacementRequestId
        ? current.orderStatus
        : await refreshParentFulfillmentStatus(tx, {
            now,
            orderId: current.orderId,
          });
      await resolveJifengExceptionIncident(tx, {
        fulfillmentId: current.fulfillmentId,
        jifengStatus: current.jifengStatus,
        now,
        priorStatus: current.fulfillmentStatus,
      });
      if (current.lastErrorCode === REMOTE_ACTIVE_AFTER_LOCAL_CANCEL_CODE) {
        await resolveSystemNotifications(tx, {
          deduplicationKeys: [
            `jifeng-cancel-conflict:${current.fulfillmentId}:${current.jifengStatus}`,
            `jifeng-match-after-cancel:${current.fulfillmentId}`,
          ],
          now,
        });
      }
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
    await resolveJifengExceptionIncident(tx, {
      fulfillmentId: current.fulfillmentId,
      jifengStatus: current.jifengStatus,
      now,
      priorStatus: current.fulfillmentStatus,
    });
    await tx
      .update(shipmentFulfillments)
      .set({
        ...clearedStatusPollState({
          nextRetryAt: nextJifengStatusPollAt(now),
          now,
          source: input.source,
        }),
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

async function parkRemoteShippedInventoryInvariant(input: {
  claimToken: string;
  detail: JifengOrderDetail;
  fulfillmentId: string;
  now: Date;
  source: "MANUAL" | "POLL";
}) {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      orderId: string;
      orderStatus: string;
      shipmentId: string;
    }>(sql`
      select
        shipment.order_id as "orderId",
        parent.status as "orderStatus",
        shipment.id as "shipmentId"
      from shipment_fulfillments fulfillment
      inner join order_shipments shipment on shipment.id = fulfillment.shipment_id
      inner join fulfillment_orders parent on parent.id = shipment.order_id
      where fulfillment.id = ${input.fulfillmentId}
        and fulfillment.status_poll_claim_token = ${input.claimToken}
      for update of fulfillment, shipment
    `);
    const current = rows[0];
    if (!current) return null;

    const shippedAt = parsedRemoteShippedAt(input.detail.shippedTime);
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
        trackingNumber: input.detail.trackingNo?.trim() || null,
        updatedAt: input.now,
      })
      .where(eq(orderShipments.id, current.shipmentId));
    await tx
      .update(shipmentFulfillments)
      .set({
        ...clearedStatusPollState({
          nextRetryAt: null,
          now: input.now,
          source: input.source,
        }),
        externalOrderNo: input.detail.orderNo ?? null,
        jifengStatus: 7,
        lastErrorCode: REMOTE_SHIP_INVENTORY_INVARIANT_CODE,
        lastErrorMessage:
          "极风显示已发货，但本地库存/锁定状态异常，请人工完成库存对账。",
        status: "EXCEPTION",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(shipmentFulfillments.id, input.fulfillmentId),
          eq(shipmentFulfillments.statusPollClaimToken, input.claimToken),
        ),
      );
    const orderStatus = await refreshParentFulfillmentStatus(tx, {
      now: input.now,
      orderId: current.orderId,
    });
    await tx.insert(auditLogs).values({
      action: "JIFENG_REMOTE_SHIPPED_INVENTORY_INVARIANT",
      actorId: null,
      actorType: "SYSTEM",
      afterJson: {
        errorCode: REMOTE_SHIP_INVENTORY_INVARIANT_CODE,
        jifengStatus: 7,
        orderStatus,
        source: input.source,
      },
      beforeJson: { orderStatus: current.orderStatus },
      entityId: current.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason: "极风已发货但本地库存无法安全扣减，已停止自动重试",
    });
    await createSystemNotification(tx, {
      deduplicationKey: `jifeng-remote-shipped-inventory:${input.fulfillmentId}`,
      entityId: input.fulfillmentId,
      entityType: "SHIPMENT_FULFILLMENT",
      message:
        "极风已确认发货，但本地库存余额或锁定记录不一致。系统已停止自动重试，请人工核对库存和运单。",
      now: input.now,
      severity: "ERROR",
      title: "极风已发货但本地库存异常",
      type: "JIFENG_EXCEPTION",
    });
    return {
      orderId: current.orderId,
      orderStatus,
      status: "EXCEPTION" as const,
    };
  });
}

export async function refreshJifengShipmentStatus(input: {
  client: JifengOrderStatusPort;
  now?: Date;
  shipmentId: string;
}) {
  const now = input.now ?? new Date();
  const claimToken = crypto.randomUUID();
  const staleLeaseCutoff = new Date(now.getTime() - STATUS_POLL_LEASE_MS);
  const claimed = await db
    .update(shipmentFulfillments)
    .set({
      statusPollClaimToken: claimToken,
      statusPollLockedAt: now,
      updatedAt: now,
    })
    .where(
      sql`${shipmentFulfillments.shipmentId} = ${input.shipmentId}
        and ${shipmentFulfillments.status} in ('SUBMITTED', 'FULFILLING', 'EXCEPTION', 'CANCEL_PENDING', 'CANCELLED', 'SHIPPED')
        and (
          ${shipmentFulfillments.statusPollLockedAt} is null
          or ${shipmentFulfillments.statusPollLockedAt} <= ${staleLeaseCutoff.toISOString()}::timestamptz
        )`,
    )
    .returning({
      erpNo: shipmentFulfillments.erpNo,
      id: shipmentFulfillments.id,
    });
  const claim = claimed[0];
  if (!claim) {
    const rows = await db
      .select({
        id: shipmentFulfillments.id,
        lockedAt: shipmentFulfillments.statusPollLockedAt,
        status: shipmentFulfillments.status,
      })
      .from(shipmentFulfillments)
      .where(eq(shipmentFulfillments.shipmentId, input.shipmentId))
      .limit(1);
    const current = rows[0];
    if (!current) {
      throw new JifengStatusRefreshError(
        "FULFILLMENT_NOT_FOUND",
        "未找到该包裹的极风履约记录",
      );
    }
    if (
      current.lockedAt &&
      new Date(current.lockedAt).getTime() > staleLeaseCutoff.getTime()
    ) {
      throw new JifengStatusRefreshError(
        "STATUS_REFRESH_IN_PROGRESS",
        "该包裹正在同步极风状态，请稍后再试",
      );
    }
    throw new JifengStatusRefreshError(
      "STATUS_NOT_REFRESHABLE",
      `当前履约状态 ${current.status} 不能立即查询极风`,
    );
  }
  const references = await db.execute<{ orderId: string }>(sql`
    select shipment.order_id as "orderId"
    from shipment_fulfillments fulfillment
    inner join order_shipments shipment on shipment.id = fulfillment.shipment_id
    where fulfillment.id = ${claim.id}
  `);
  const reference = references[0];
  if (!reference) {
    throw new JifengStatusRefreshError(
      "FULFILLMENT_NOT_FOUND",
      "未找到该包裹的极风履约记录",
    );
  }

  let detail: JifengOrderDetail | null = null;
  try {
    const response = await input.client.getOrder({ erpNo: claim.erpNo });
    detail = response;
    if (response.erpNo !== claim.erpNo) {
      throw new JifengApiError({
        code: "INVALID_RESPONSE",
        message: "极风状态查询返回了不匹配的包裹标识",
        retryable: true,
      });
    }
    return await db.transaction(async (tx) => {
      const owned = await tx.execute<{ id: string }>(sql`
        select id
        from shipment_fulfillments
        where id = ${claim.id}
          and status_poll_claim_token = ${claimToken}
        for update
      `);
      if (!owned[0]) {
        throw new JifengStatusRefreshError(
          "STATUS_REFRESH_STALE",
          "本次极风状态查询租约已失效，请重新查询",
        );
      }
      const result = await applyJifengOrderStatus({
        detail: response,
        now,
        source: "MANUAL",
      }, tx);
      return { ...result, orderId: reference.orderId };
    });
  } catch (error) {
    if (
      detail?.status === 7 &&
      isRemoteShippedInventoryInvariantFailure(error)
    ) {
      const parked = await parkRemoteShippedInventoryInvariant({
        claimToken,
        detail,
        fulfillmentId: claim.id,
        now,
        source: "MANUAL",
      });
      if (parked) return parked;
    }
    await db
      .update(shipmentFulfillments)
      .set({
        statusPollClaimToken: null,
        statusPollLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(shipmentFulfillments.id, claim.id),
          eq(shipmentFulfillments.statusPollClaimToken, claimToken),
        ),
      );
    throw error;
  }
}

export async function pollActiveJifengFulfillments(input: {
  client: JifengOrderStatusPort;
  limit?: number;
  now?: Date;
}) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("极风状态轮询批量大小必须在 1 到 500 之间");
  }
  const summary = {
    exceptions: 0,
    pollFailures: 0,
    shipped: 0,
    synced: 0,
  };
  for (let processed = 0; processed < limit; processed += 1) {
    const now = input.now ?? new Date();
    const claimToken = crypto.randomUUID();
    const staleLeaseCutoff = new Date(now.getTime() - STATUS_POLL_LEASE_MS);
    const claimedRows = await db.execute<{ erpNo: string; id: string }>(sql`
      with due as (
        select id
        from shipment_fulfillments
        where (
            (
              status in ('SUBMITTED', 'FULFILLING', 'EXCEPTION', 'CANCEL_PENDING')
              and (
                submitted_at is not null
                or jifeng_status is not null
                or exists (
                  select 1
                  from integration_outbox as create_event
                  where create_event.aggregate_id = shipment_fulfillments.shipment_id::text
                    and create_event.target = 'JIFENG'
                    and create_event.event_type = 'JIFENG_CREATE_ORDER'
                    and (
                      create_event.last_error_code in (
                        'TIMEOUT',
                        'NETWORK_ERROR',
                        'INVALID_RESPONSE',
                        'INTERNAL_ERROR',
                        'POST_SUCCESS_PERSISTENCE_ERROR',
                        'STALE_PROCESSING',
                        '50019',
                        '50038'
                      )
                      or left(create_event.last_error_code, 5) = 'HTTP_'
                      or left(create_event.last_error_code, 24) = 'RECONCILIATION_REQUIRED:'
                    )
                )
              )
            )
            or (
              status = 'SHIPPED'
              and exists (
                select 1
                from order_shipments shipped_metadata
                where shipped_metadata.id = shipment_fulfillments.shipment_id
                  and (
                    shipped_metadata.logistics_fee_minor is null
                    or nullif(trim(shipped_metadata.tracking_number), '') is null
                    or shipped_metadata.shipped_at is null
                    or shipment_fulfillments.shipped_at is null
                  )
              )
            )
          )
          and coalesce(last_error_code, '') not in (
            'REMOTE_SHIP_INVENTORY_INVARIANT_MISMATCH',
            'REMOTE_SHIPPED_AFTER_LOCAL_CANCEL'
          )
          and (next_retry_at is null or next_retry_at <= ${now.toISOString()}::timestamptz)
          and (
            status_poll_locked_at is null
            or status_poll_locked_at <= ${staleLeaseCutoff.toISOString()}::timestamptz
          )
        order by coalesce(next_retry_at, submitted_at, created_at), id
        for update skip locked
        limit 1
      )
      update shipment_fulfillments as fulfillment
      set
        status_poll_claim_token = ${claimToken},
        status_poll_locked_at = ${now.toISOString()}::timestamptz
      from due
      where fulfillment.id = due.id
      returning fulfillment.erp_no as "erpNo", fulfillment.id
    `);
    const fulfillment = claimedRows[0];
    if (!fulfillment) break;
    let detail: JifengOrderDetail | null = null;
    try {
      const response = await input.client.getOrder({ erpNo: fulfillment.erpNo });
      detail = response;
      if (response.erpNo !== fulfillment.erpNo) {
        throw new JifengApiError({
          code: "INVALID_RESPONSE",
          message: "极风状态查询返回了不匹配的包裹标识",
          retryable: true,
        });
      }
      const result = await db.transaction(async (tx) => {
        const claimed = await tx.execute<{ id: string }>(sql`
          select id
          from shipment_fulfillments
          where erp_no = ${fulfillment.erpNo}
            and status_poll_claim_token = ${claimToken}
          for update
        `);
        if (!claimed[0]) return null;
        return applyJifengOrderStatus(
          { detail: response, now, source: "POLL" },
          tx,
        );
      });
      if (!result) continue;
      if (result.status === "SHIPPED") summary.shipped += 1;
      else if (result.status === "EXCEPTION") summary.exceptions += 1;
      else summary.synced += 1;
    } catch (error) {
      if (
        detail?.status === 7 &&
        isRemoteShippedInventoryInvariantFailure(error)
      ) {
        const parked = await parkRemoteShippedInventoryInvariant({
          claimToken,
          detail,
          fulfillmentId: fulfillment.id,
          now,
          source: "POLL",
        });
        if (parked) {
          summary.exceptions += 1;
          continue;
        }
      }
      const failure = statusPollFailure(error);
      await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          fulfillmentId: string;
          fulfillmentStatus: string;
          statusPollFailureCount: number;
        }>(sql`
          select
            f.id as "fulfillmentId",
            f.status as "fulfillmentStatus",
            f.status_poll_failure_count as "statusPollFailureCount"
          from shipment_fulfillments f
          where f.erp_no = ${fulfillment.erpNo}
            and f.status_poll_claim_token = ${claimToken}
          for update of f
        `);
        const row = locked[0];
        if (!row) return;
        const failureCount = row.statusPollFailureCount + 1;
        const nextRetryAt =
          row.fulfillmentStatus === "SHIPPED" && failure.retryable
            ? new Date(now.getTime() + SHIPPED_METADATA_POLL_INTERVAL_MS)
            : statusPollRetryAt({
                failureCount,
                now,
                retryable: failure.retryable,
              });
        await tx
          .update(shipmentFulfillments)
          .set({
            lastStatusPollAt: now,
            lastStatusPollErrorCode: failure.code,
            lastStatusPollErrorMessage: failure.message,
            nextRetryAt,
            statusPollClaimToken: null,
            statusPollFailureCount: failureCount,
            statusPollLockedAt: null,
            updatedAt: now,
          })
          .where(eq(shipmentFulfillments.id, row.fulfillmentId));
        await tx.insert(auditLogs).values({
          action: "JIFENG_STATUS_POLL_FAILED",
          actorId: null,
          actorType: "SYSTEM",
          afterJson: {
            errorCode: "STATUS_POLL_FAILED",
            failureCount,
            nextRetryAt: nextRetryAt.toISOString(),
            providerErrorCode: failure.code,
            retryable: failure.retryable,
          },
          beforeJson: { fulfillmentStatus: row.fulfillmentStatus },
          entityId: row.fulfillmentId,
          entityType: "SHIPMENT_FULFILLMENT",
          reason: "极风状态查询失败，已安排重试",
        });
        if (!failure.retryable || failureCount >= STATUS_POLL_WARNING_THRESHOLD) {
          await createSystemNotification(tx, {
            deduplicationKey: `jifeng-poll-failed:${row.fulfillmentId}`,
            entityId: row.fulfillmentId,
            entityType: "SHIPMENT_FULFILLMENT",
            message: failure.retryable
              ? `极风状态查询已连续失败 ${failureCount} 次，系统已退避重试；远端订单不会因此重复创建。`
              : "极风状态查询返回不可重试错误，请检查极风连接；远端订单不会因此重复创建。",
            now,
            severity: "WARNING",
            title: "极风状态查询失败",
            type: "JIFENG_POLL_FAILED",
          });
        }
      });
      summary.pollFailures += 1;
    }
  }
  return summary;
}
