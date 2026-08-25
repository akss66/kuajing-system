import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  shipmentCancellationAdjustments,
} from "@/db/schema";
import { cancelFulfillmentOrder, OrderLifecycleError } from "@/modules/orders/lifecycle";

import {
  cancelJifengShipment,
  type JifengCancelOrderPort,
  ReplacementError,
} from "./replacement";
import {
  type JifengOrderStatusPort,
  refreshJifengShipmentStatus,
} from "./status-sync";

const REFRESHABLE_STATUSES = new Set([
  "SUBMITTED",
  "FULFILLING",
  "EXCEPTION",
  "CANCEL_PENDING",
  "CANCELLED",
  "SHIPPED",
]);
const NON_CANCELLABLE_STATUSES = new Set([
  "SHIPPED",
  "CANCELLED",
  "CANCEL_PENDING",
]);

export class OrderOperationsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrderOperationsError";
  }
}

type OrderShipmentReference = {
  externalOrderNo: string;
  shipmentId: string;
  status: string | null;
};

async function getOrderShipmentReferences(orderId: string) {
  const orders = await db
    .select({ id: fulfillmentOrders.id, status: fulfillmentOrders.status })
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.id, orderId))
    .limit(1);
  if (!orders[0]) {
    throw new OrderOperationsError("ORDER_NOT_FOUND", "未找到该拿货单");
  }
  const shipments = await db.execute<OrderShipmentReference>(sql`
    select
      shipment.external_order_no as "externalOrderNo",
      shipment.id as "shipmentId",
      fulfillment.status::text as status
    from order_shipments shipment
    left join shipment_fulfillments fulfillment
      on fulfillment.shipment_id = shipment.id
    where shipment.order_id = ${orderId}
    order by shipment.created_at, shipment.id
  `);
  return { order: orders[0], shipments };
}

export async function refreshAllJifengShipmentStatuses(input: {
  client: JifengOrderStatusPort;
  now?: Date;
  orderId: string;
}) {
  const { shipments } = await getOrderShipmentReferences(input.orderId);
  const items: Array<{
    externalOrderNo: string;
    outcome: "FAILED" | "REFRESHED" | "SKIPPED";
    shipmentId: string;
  }> = [];

  // Deliberately query sequentially to avoid producing a burst against Jifeng.
  for (const shipment of shipments) {
    if (!shipment.status || !REFRESHABLE_STATUSES.has(shipment.status)) {
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "SKIPPED",
        shipmentId: shipment.shipmentId,
      });
      continue;
    }
    try {
      await refreshJifengShipmentStatus({
        client: input.client,
        now: input.now,
        shipmentId: shipment.shipmentId,
      });
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "REFRESHED",
        shipmentId: shipment.shipmentId,
      });
    } catch {
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "FAILED",
        shipmentId: shipment.shipmentId,
      });
    }
  }

  return {
    failedCount: items.filter((item) => item.outcome === "FAILED").length,
    items,
    refreshedCount: items.filter((item) => item.outcome === "REFRESHED").length,
    skippedCount: items.filter((item) => item.outcome === "SKIPPED").length,
  };
}

export async function cancelAllCancellableOrderShipments(input: {
  actorUserId: string;
  getClient?: () => Promise<JifengCancelOrderPort>;
  now?: Date;
  orderId: string;
  reason: string;
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new OrderOperationsError("CANCEL_REASON_REQUIRED", "取消拿货单必须填写原因");
  }
  if (reason.length > 1000) {
    throw new OrderOperationsError(
      "CANCEL_REASON_TOO_LONG",
      "取消原因不能超过 1000 个字符",
    );
  }

  let snapshot = await getOrderShipmentReferences(input.orderId);
  if (snapshot.order.status === "CANCELLED") {
    return {
      cancelledCount: 0,
      failedCount: 0,
      items: snapshot.shipments.map((shipment) => ({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "SKIPPED" as const,
        shipmentId: shipment.shipmentId,
      })),
      orderStatus: "CANCELLED",
      pendingCount: 0,
      skippedCount: snapshot.shipments.length,
    };
  }
  if (snapshot.order.status === "EXPIRED") {
    throw new OrderOperationsError(
      "ORDER_NOT_CANCELLABLE",
      "该拿货单已过期，不能再执行整单取消",
    );
  }

  if (["PENDING_PAYMENT", "PAID_PENDING_FULFILLMENT"].includes(snapshot.order.status)) {
    try {
      await cancelFulfillmentOrder({
        actorType: "ADMIN",
        actorUserId: input.actorUserId,
        now: input.now,
        orderId: input.orderId,
        reason,
      });
      return {
        cancelledCount: snapshot.shipments.length,
        failedCount: 0,
        items: snapshot.shipments.map((shipment) => ({
          externalOrderNo: shipment.externalOrderNo,
          outcome: "CANCELLED" as const,
          shipmentId: shipment.shipmentId,
        })),
        orderStatus: "CANCELLED",
        pendingCount: 0,
        skippedCount: 0,
      };
    } catch (error) {
      if (
        !(error instanceof OrderLifecycleError) ||
        error.code !== "FULFILLMENT_CANCEL_REQUIRED"
      ) {
        throw error;
      }
      // A fulfillment process won the race; continue through the safe
      // package-level path. Re-read first so a fulfillment row created after
      // the initial snapshot cannot be mistaken for a package to skip.
      snapshot = await getOrderShipmentReferences(input.orderId);
    }
  }

  let clientPromise: Promise<JifengCancelOrderPort> | null = null;
  const items: Array<{
    externalOrderNo: string;
    outcome: "CANCELLED" | "FAILED" | "PENDING" | "SKIPPED";
    shipmentId: string;
  }> = [];
  for (const shipment of snapshot.shipments) {
    if (!shipment.status || NON_CANCELLABLE_STATUSES.has(shipment.status)) {
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "SKIPPED",
        shipmentId: shipment.shipmentId,
      });
      continue;
    }
    try {
      let result: Awaited<ReturnType<typeof cancelJifengShipment>>;
      try {
        result = await cancelJifengShipment({
          actorUserId: input.actorUserId,
          now: input.now,
          reason,
          shipmentId: shipment.shipmentId,
        });
      } catch (error) {
        if (!(error instanceof ReplacementError) || error.code !== "JIFENG_CLIENT_REQUIRED") {
          throw error;
        }
        if (!input.getClient) {
          throw new OrderOperationsError(
            "JIFENG_CLIENT_REQUIRED",
            "极风连接不可用，已绑定的包裹未取消",
          );
        }
        clientPromise ??= input.getClient();
        result = await cancelJifengShipment({
          actorUserId: input.actorUserId,
          client: await clientPromise,
          now: input.now,
          reason,
          shipmentId: shipment.shipmentId,
        });
      }
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome:
          result.status === "CANCEL_PENDING"
            ? "PENDING"
            : result.status === "ALREADY_CANCELLED"
              ? "SKIPPED"
              : "CANCELLED",
        shipmentId: shipment.shipmentId,
      });
    } catch (error) {
      if (error instanceof ReplacementError) {
        if (error.code === "CANCELLATION_IN_PROGRESS") {
          items.push({
            externalOrderNo: shipment.externalOrderNo,
            outcome: "PENDING",
            shipmentId: shipment.shipmentId,
          });
          continue;
        }
        if (error.code === "ALREADY_SHIPPED") {
          items.push({
            externalOrderNo: shipment.externalOrderNo,
            outcome: "SKIPPED",
            shipmentId: shipment.shipmentId,
          });
          continue;
        }
      }
      items.push({
        externalOrderNo: shipment.externalOrderNo,
        outcome: "FAILED",
        shipmentId: shipment.shipmentId,
      });
    }
  }

  const statuses = await db
    .select({ status: fulfillmentOrders.status })
    .from(fulfillmentOrders)
    .where(eq(fulfillmentOrders.id, input.orderId))
    .limit(1);
  return {
    cancelledCount: items.filter((item) => item.outcome === "CANCELLED").length,
    failedCount: items.filter((item) => item.outcome === "FAILED").length,
    items,
    orderStatus: statuses[0]?.status ?? snapshot.order.status,
    pendingCount: items.filter((item) => item.outcome === "PENDING").length,
    skippedCount: items.filter((item) => item.outcome === "SKIPPED").length,
  };
}

export async function completeAllOfflineOrderRefunds(input: {
  actorUserId: string;
  adminUserId: string;
  note: string;
  now?: Date;
  orderId: string;
}) {
  const note = input.note.trim();
  if (!note) {
    throw new OrderOperationsError(
      "COMPLETION_NOTE_REQUIRED",
      "确认线下退款必须填写凭证或备注",
    );
  }
  if (note.length > 1000) {
    throw new OrderOperationsError(
      "COMPLETION_NOTE_TOO_LONG",
      "线下退款备注不能超过 1000 个字符",
    );
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const orderRows = await tx.execute<{ id: string }>(sql`
      select id
      from fulfillment_orders
      where id = ${input.orderId}
      for update
    `);
    if (!orderRows[0]) {
      throw new OrderOperationsError("ORDER_NOT_FOUND", "未找到该拿货单");
    }
    const rows = await tx.execute<{
      id: string;
      offlineAmountFen: number;
      shipmentId: string;
      status: string;
    }>(sql`
      select
        id,
        offline_amount_fen as "offlineAmountFen",
        shipment_id as "shipmentId",
        status
      from shipment_cancellation_adjustments
      where order_id = ${input.orderId}
      order by id
      for update
    `);
    if (rows.length === 0) {
      throw new OrderOperationsError(
        "OFFLINE_REFUND_NOT_FOUND",
        "该拿货单没有取消退款记录",
      );
    }
    const pending = rows.filter(
      (row) => row.status === "PENDING_OFFLINE" && row.offlineAmountFen > 0,
    );
    if (pending.length === 0) {
      return {
        completedAmountFen: 0,
        completedCount: 0,
        status: "ALREADY_COMPLETED" as const,
      };
    }

    await tx
      .update(shipmentCancellationAdjustments)
      .set({
        offlineCompletedAt: now,
        offlineCompletedByAdminUserId: input.adminUserId,
        offlineCompletionNote: note,
        status: "COMPLETED",
        updatedAt: now,
      })
      .where(sql`${shipmentCancellationAdjustments.id} in (${sql.join(
        pending.map((row) => sql`${row.id}`),
        sql`, `,
      )})`);
    await tx.insert(auditLogs).values(
      pending.map((row) => ({
        action: "SHIPMENT_OFFLINE_REFUND_COMPLETED",
        actorId: input.actorUserId,
        actorType: "ADMIN" as const,
        afterJson: {
          completedAt: now.toISOString(),
          note,
          offlineAmountFen: row.offlineAmountFen,
          status: "COMPLETED",
        },
        beforeJson: { status: "PENDING_OFFLINE" },
        entityId: row.shipmentId,
        entityType: "ORDER_SHIPMENT",
        reason: note,
      })),
    );
    const completedAmountFen = pending.reduce(
      (sum, row) => sum + row.offlineAmountFen,
      0,
    );
    await tx.insert(auditLogs).values({
      action: "ORDER_OFFLINE_REFUNDS_COMPLETED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {
        completedAmountFen,
        completedAt: now.toISOString(),
        completedCount: pending.length,
        note,
      },
      beforeJson: {
        pendingAmountFen: completedAmountFen,
        pendingCount: pending.length,
      },
      entityId: input.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: note,
    });
    return {
      completedAmountFen,
      completedCount: pending.length,
      status: "COMPLETED" as const,
    };
  });
}
