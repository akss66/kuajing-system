import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  integrationOutbox,
  inventoryReservations,
  paymentClaims,
  settlementBatchOrders,
  settlementPaymentClaims,
  shipmentFulfillments,
} from "@/db/schema";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { refundWalletForOrder } from "@/modules/wallet/service";

const PAYMENT_CLAIM_LOCK_MS = 12 * 60 * 60 * 1000;
const PENDING_PAYMENT_LOCK_MS = 2 * 60 * 60 * 1000;

export class OrderLifecycleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OrderLifecycleError";
  }
}

function assertFen(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new OrderLifecycleError("INVALID_AMOUNT", "付款金额必须是有效的人民币分整数");
  }
}

function asDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

export async function declareOfflinePayment(input: {
  actorUserId: string;
  amountFen: number;
  customerId: string;
  note?: string;
  now?: Date;
  orderId: string;
}) {
  assertFen(input.amountFen);
  const now = input.now ?? new Date();
  const note = input.note?.trim() || null;
  if (note && note.length > 500) {
    throw new OrderLifecycleError("NOTE_TOO_LONG", "付款备注不能超过 500 个字符");
  }

  return db.transaction(async (tx) => {
    const orders = await tx.execute<{
      id: string;
      lockExpiresAt: Date | string | null;
      paymentDeclaredAt: Date | string | null;
      status: string;
      totalAmountFen: number;
    }>(sql`
      select
        id,
        lock_expires_at as "lockExpiresAt",
        payment_declared_at as "paymentDeclaredAt",
        status,
        total_amount_fen as "totalAmountFen"
      from fulfillment_orders
      where id = ${input.orderId} and customer_id = ${input.customerId}
      for update
    `);
    const order = orders[0];
    if (!order) {
      throw new OrderLifecycleError("ORDER_NOT_FOUND", "未找到该拿货单");
    }
    if (order.status !== "PENDING_PAYMENT") {
      throw new OrderLifecycleError("ORDER_NOT_PENDING_PAYMENT", "该拿货单当前不能申报付款");
    }
    const previousLockExpiresAt = asDate(order.lockExpiresAt);
    const previousPaymentDeclaredAt = asDate(order.paymentDeclaredAt);
    if (previousLockExpiresAt && previousLockExpiresAt <= now) {
      throw new OrderLifecycleError("ORDER_LOCK_EXPIRED", "该拿货单的库存锁定已超时");
    }
    if (order.totalAmountFen !== input.amountFen) {
      throw new OrderLifecycleError(
        "PAYMENT_AMOUNT_MISMATCH",
        "申报金额必须与拿货单应付金额一致",
      );
    }

    const [existingClaim] = await tx
      .select({
        amountFen: paymentClaims.amountFen,
        id: paymentClaims.id,
        status: paymentClaims.status,
      })
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.orderId, input.orderId),
          eq(paymentClaims.status, "PENDING"),
        ),
      )
      .limit(1);
    if (existingClaim) {
      return {
        amountFen: existingClaim.amountFen,
        claimId: existingClaim.id,
        lockExpiresAt: previousLockExpiresAt,
        status: existingClaim.status,
      };
    }

    const lockExpiresAt = new Date(now.getTime() + PAYMENT_CLAIM_LOCK_MS);
    const [claim] = await tx
      .insert(paymentClaims)
      .values({
        amountFen: input.amountFen,
        customerId: input.customerId,
        note,
        orderId: input.orderId,
      })
      .returning({ id: paymentClaims.id, status: paymentClaims.status });
    await tx
      .update(fulfillmentOrders)
      .set({ lockExpiresAt, paymentDeclaredAt: now, updatedAt: now })
      .where(eq(fulfillmentOrders.id, input.orderId));
    await tx
      .update(inventoryReservations)
      .set({ expiresAt: lockExpiresAt, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          eq(inventoryReservations.referenceId, input.orderId),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    await tx.insert(auditLogs).values({
      action: "OFFLINE_PAYMENT_DECLARED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        amountFen: input.amountFen,
        claimId: claim.id,
        lockExpiresAt: lockExpiresAt.toISOString(),
      },
      beforeJson: {
        lockExpiresAt: previousLockExpiresAt?.toISOString() ?? null,
        paymentDeclaredAt: previousPaymentDeclaredAt?.toISOString() ?? null,
      },
      entityId: input.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: "客户声明已通过微信线下支付",
    });

    return {
      amountFen: input.amountFen,
      claimId: claim.id,
      lockExpiresAt,
      status: claim.status,
    };
  });
}

export async function reviewOfflinePayment(input: {
  actorUserId: string;
  adminUserId: string;
  claimId: string;
  decision: "APPROVE" | "REJECT";
  now?: Date;
  rejectionReason?: string;
}) {
  const now = input.now ?? new Date();
  const rejectionReason = input.rejectionReason?.trim() || null;
  if (input.decision === "REJECT") {
    if (!rejectionReason) {
      throw new OrderLifecycleError(
        "REJECTION_REASON_REQUIRED",
        "拒绝付款声明必须填写原因",
      );
    }
    if (rejectionReason.length > 1000) {
      throw new OrderLifecycleError(
        "REJECTION_REASON_TOO_LONG",
        "拒绝原因不能超过 1000 个字符",
      );
    }
  }

  return db.transaction(async (tx) => {
    const [claimReference] = await tx
      .select({ orderId: paymentClaims.orderId })
      .from(paymentClaims)
      .where(eq(paymentClaims.id, input.claimId))
      .limit(1);
    if (!claimReference) {
      throw new OrderLifecycleError("PAYMENT_CLAIM_NOT_FOUND", "未找到付款声明");
    }

    const orderRows = await tx.execute<{
      lockExpiresAt: Date | string | null;
      orderStatus: string;
    }>(sql`
      select
        lock_expires_at as "lockExpiresAt",
        status as "orderStatus"
      from fulfillment_orders
      where id = ${claimReference.orderId}
      for update
    `);
    const claimRows = await tx.execute<{
      amountFen: number;
      claimStatus: string;
      customerId: string;
      orderId: string;
    }>(sql`
      select
        amount_fen as "amountFen",
        status as "claimStatus",
        customer_id as "customerId",
        order_id as "orderId"
      from payment_claims
      where id = ${input.claimId} and order_id = ${claimReference.orderId}
      for update
    `);
    const claimRow = claimRows[0];
    const orderRow = orderRows[0];
    if (!claimRow || !orderRow) {
      throw new OrderLifecycleError("PAYMENT_CLAIM_NOT_FOUND", "未找到付款声明");
    }
    const claim = { ...claimRow, ...orderRow };
    if (claim.claimStatus !== "PENDING") {
      throw new OrderLifecycleError("PAYMENT_CLAIM_REVIEWED", "该付款声明已经处理");
    }
    if (claim.orderStatus !== "PENDING_PAYMENT") {
      throw new OrderLifecycleError("ORDER_NOT_PENDING_PAYMENT", "该拿货单当前不能核款");
    }
    const lockExpiresAt = asDate(claim.lockExpiresAt);
    if (lockExpiresAt && lockExpiresAt <= now) {
      throw new OrderLifecycleError("ORDER_LOCK_EXPIRED", "该拿货单的库存锁定已超时");
    }

    if (input.decision === "REJECT") {
      const restoredLockExpiresAt = new Date(now.getTime() + PENDING_PAYMENT_LOCK_MS);
      await tx
        .update(paymentClaims)
        .set({
          rejectionReason,
          reviewedAt: now,
          reviewedByAdminUserId: input.adminUserId,
          status: "REJECTED",
          updatedAt: now,
        })
        .where(eq(paymentClaims.id, input.claimId));
      await tx
        .update(fulfillmentOrders)
        .set({
          lockExpiresAt: restoredLockExpiresAt,
          paymentDeclaredAt: null,
          updatedAt: now,
        })
        .where(eq(fulfillmentOrders.id, claim.orderId));
      await tx
        .update(inventoryReservations)
        .set({ expiresAt: restoredLockExpiresAt, updatedAt: now })
        .where(
          and(
            eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
            eq(inventoryReservations.referenceId, claim.orderId),
            eq(inventoryReservations.status, "ACTIVE"),
          ),
        );
      await tx.insert(auditLogs).values({
        action: "OFFLINE_PAYMENT_REJECTED",
        actorId: input.actorUserId,
        actorType: "ADMIN",
        afterJson: {
          claimStatus: "REJECTED",
          lockExpiresAt: restoredLockExpiresAt.toISOString(),
          rejectionReason,
        },
        beforeJson: {
          claimStatus: claim.claimStatus,
          lockExpiresAt: lockExpiresAt?.toISOString() ?? null,
        },
        entityId: claim.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: rejectionReason!,
      });

      return { orderId: claim.orderId, status: "PENDING_PAYMENT" as const };
    }

    await tx
      .update(paymentClaims)
      .set({
        rejectionReason: null,
        reviewedAt: now,
        reviewedByAdminUserId: input.adminUserId,
        status: "APPROVED",
        updatedAt: now,
      })
      .where(eq(paymentClaims.id, input.claimId));
    await tx
      .update(fulfillmentOrders)
      .set({
        lockExpiresAt: null,
        paidAt: now,
        paymentMode: "DIRECT_OFFLINE",
        status: "PAID_PENDING_FULFILLMENT",
        updatedAt: now,
      })
      .where(eq(fulfillmentOrders.id, claim.orderId));
    await tx
      .update(inventoryReservations)
      .set({ expiresAt: null, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          eq(inventoryReservations.referenceId, claim.orderId),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    await tx.insert(auditLogs).values({
      action: "OFFLINE_PAYMENT_APPROVED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {
        claimStatus: "APPROVED",
        orderStatus: "PAID_PENDING_FULFILLMENT",
        paymentMode: "DIRECT_OFFLINE",
      },
      beforeJson: {
        claimStatus: claim.claimStatus,
        orderStatus: claim.orderStatus,
      },
      entityId: claim.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: "管理员确认微信线下付款到账",
    });

    return { orderId: claim.orderId, status: "PAID_PENDING_FULFILLMENT" as const };
  });
}

export async function cancelFulfillmentOrder(input: {
  actorType: "ADMIN" | "CUSTOMER";
  actorUserId: string;
  customerId?: string;
  now?: Date;
  orderId: string;
  reason: string;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) {
    throw new OrderLifecycleError("CANCEL_REASON_REQUIRED", "取消拿货单必须填写原因");
  }
  if (reason.length > 1000) {
    throw new OrderLifecycleError("CANCEL_REASON_TOO_LONG", "取消原因不能超过 1000 个字符");
  }
  if (input.actorType === "CUSTOMER" && !input.customerId) {
    throw new OrderLifecycleError("CUSTOMER_REQUIRED", "客户身份信息缺失");
  }

  return db.transaction(async (tx) => {
    const [allocationReference] = await tx
      .select({
        settlementBatchId: settlementBatchOrders.settlementBatchId,
        walletAmountFen: settlementBatchOrders.walletAmountFen,
      })
      .from(settlementBatchOrders)
      .where(
        and(
          eq(settlementBatchOrders.orderId, input.orderId),
          input.actorType === "CUSTOMER"
            ? eq(settlementBatchOrders.customerId, input.customerId!)
            : undefined,
        ),
      )
      .limit(1);
    if (allocationReference) {
      await tx.execute(sql`
        select id
        from settlement_batches
        where id = ${allocationReference.settlementBatchId}
        for update
      `);
    }
    const customerFilter =
      input.actorType === "CUSTOMER" ? sql`and customer_id = ${input.customerId!}` : sql``;
    const orderRows = await tx.execute<{
      cancelReason: string | null;
      customerId: string;
      paymentMode: string | null;
      status: string;
      totalAmountFen: number;
    }>(sql`
      select
        cancel_reason as "cancelReason",
        customer_id as "customerId",
        payment_mode as "paymentMode",
        status,
        total_amount_fen as "totalAmountFen"
      from fulfillment_orders
      where id = ${input.orderId} ${customerFilter}
      for update
    `);
    const order = orderRows[0];
    if (!order) {
      throw new OrderLifecycleError("ORDER_NOT_FOUND", "未找到该拿货单");
    }
    const settlementReference = allocationReference;
    if (settlementReference) {
      const [pendingUnifiedClaim] = await tx
        .select({ id: settlementPaymentClaims.id })
        .from(settlementPaymentClaims)
        .where(
          and(
            eq(
              settlementPaymentClaims.settlementBatchId,
              settlementReference.settlementBatchId,
            ),
            eq(settlementPaymentClaims.status, "PENDING"),
          ),
        )
        .limit(1);
      if (pendingUnifiedClaim) {
        throw new OrderLifecycleError(
          "SETTLEMENT_CLAIM_PENDING",
          "该拿货单属于待核款结算批次，请先撤回整笔付款声明",
        );
      }
    }
    if (order.status === "CANCELLED") {
      return { orderId: input.orderId, status: "CANCELLED" as const };
    }
    if (!['PENDING_PAYMENT', 'PAID_PENDING_FULFILLMENT'].includes(order.status)) {
      if (["FULFILLING", "FULFILLMENT_EXCEPTION"].includes(order.status)) {
        throw new OrderLifecycleError(
          "FULFILLMENT_CANCEL_REQUIRED",
          "This order has entered Jifeng fulfillment; use the Jifeng cancellation flow",
        );
      }
      throw new OrderLifecycleError("ORDER_CANNOT_CANCEL", "该拿货单当前不能取消");
    }

    const fulfillmentRows = await tx.execute<{
      attemptCount: number;
      externalOrderNo: string | null;
      status: string;
      submittedAt: Date | string | null;
    }>(sql`
      select
        f.attempt_count as "attemptCount",
        f.external_order_no as "externalOrderNo",
        f.status,
        f.submitted_at as "submittedAt"
      from shipment_fulfillments f
      inner join order_shipments s on s.id = f.shipment_id
      where s.order_id = ${input.orderId}
      order by f.id
      for update of f
    `);
    const outboxRows = await tx.execute<{ attemptCount: number; status: string }>(sql`
      select e.attempt_count as "attemptCount", e.status
      from integration_outbox e
      inner join order_shipments s on s.id::text = e.aggregate_id
      where s.order_id = ${input.orderId}
        and e.target = 'JIFENG'
        and e.event_type = 'JIFENG_CREATE_ORDER'
      order by e.id
      for update of e
    `);
    if (
      fulfillmentRows.some(
        (fulfillment) =>
          fulfillment.attemptCount !== 0 ||
          fulfillment.externalOrderNo !== null ||
          fulfillment.submittedAt !== null ||
          fulfillment.status !== "PENDING",
      ) ||
      outboxRows.some(
        (event) => event.attemptCount !== 0 || event.status !== "PENDING",
      )
    ) {
      throw new OrderLifecycleError(
        "FULFILLMENT_CANCEL_REQUIRED",
        "该拿货单已进入极风发货流程，请使用极风取消流程处理",
      );
    }
    await tx
      .update(shipmentFulfillments)
      .set({
        cancelledAt: now,
        lastErrorCode: "ORDER_CANCELLED",
        lastErrorMessage: "Local order cancellation",
        nextRetryAt: null,
        status: "CANCELLED",
        updatedAt: now,
      })
      .where(sql`${shipmentFulfillments.id} in (
        select f.id from shipment_fulfillments f
        inner join order_shipments s on s.id = f.shipment_id
        where s.order_id = ${input.orderId} and f.status in ('PENDING', 'EXCEPTION')
      )`);
    await tx
      .update(integrationOutbox)
      .set({
        claimToken: null,
        completedAt: now,
        lastErrorCode: "ORDER_CANCELLED",
        lastErrorMessage: "Local order cancellation",
        lockedAt: null,
        status: "COMPLETED",
        updatedAt: now,
      })
      .where(sql`${integrationOutbox.id} in (
        select e.id from integration_outbox e
        inner join order_shipments s on s.id::text = e.aggregate_id
        where s.order_id = ${input.orderId}
          and e.target = 'JIFENG'
          and e.event_type = 'JIFENG_CREATE_ORDER'
          and e.status in ('PENDING', 'FAILED')
      )`);

    const walletRefundFen = settlementReference
      ? settlementReference.walletAmountFen
      : order.paymentMode === "WALLET"
        ? order.totalAmountFen
        : 0;
    if (order.status === "PAID_PENDING_FULFILLMENT" && walletRefundFen > 0) {
      await refundWalletForOrder(tx, {
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        amountFen: walletRefundFen,
        customerId: order.customerId,
        orderId: input.orderId,
        reason: `订单取消退款：${reason}`,
      });
    }

    await tx
      .update(inventoryReservations)
      .set({
        expiresAt: null,
        releaseReason: `订单取消：${reason}`,
        status: "RELEASED",
        updatedAt: now,
      })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          eq(inventoryReservations.referenceId, input.orderId),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    await tx
      .update(paymentClaims)
      .set({
        rejectionReason: `订单已取消：${reason}`,
        reviewedAt: now,
        status: "REJECTED",
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentClaims.orderId, input.orderId),
          eq(paymentClaims.status, "PENDING"),
        ),
      );
    await tx
      .update(fulfillmentOrders)
      .set({
        cancelReason: reason,
        cancelledAt: now,
        lockExpiresAt: null,
        status: "CANCELLED",
        updatedAt: now,
      })
      .where(eq(fulfillmentOrders.id, input.orderId));
    await tx.insert(auditLogs).values({
      action: "FULFILLMENT_ORDER_CANCELLED",
      actorId: input.actorUserId,
      actorType: input.actorType,
      afterJson: { cancelReason: reason, status: "CANCELLED" },
      beforeJson: {
        paymentMode: order.paymentMode,
        status: order.status,
      },
      entityId: input.orderId,
      entityType: "FULFILLMENT_ORDER",
      reason,
    });
    await enqueueCargoSyncEvent(tx, {
      idempotencyKey: `order-cancelled:${input.orderId}`,
      now,
      reason: "order-inventory-released",
    });

    return { orderId: input.orderId, status: "CANCELLED" as const };
  });
}

export async function expirePendingPaymentOrders(input?: {
  limit?: number;
  now?: Date;
}) {
  const now = input?.now ?? new Date();
  const limit = input?.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new OrderLifecycleError("INVALID_EXPIRY_LIMIT", "超时任务批量大小必须在 1 到 500 之间");
  }

  return db.transaction(async (tx) => {
    const expiredOrders = await tx.execute<{
      id: string;
      lockExpiresAt: Date | string;
    }>(sql`
      select id, lock_expires_at as "lockExpiresAt"
      from fulfillment_orders
      where status = 'PENDING_PAYMENT'
        and lock_expires_at is not null
        and lock_expires_at <= ${now.toISOString()}::timestamptz
        and not exists (
          select 1
          from settlement_batch_orders allocation
          inner join settlement_batches batch
            on batch.id = allocation.settlement_batch_id
          where allocation.order_id = fulfillment_orders.id
            and batch.status in ('PENDING_PAYMENT', 'PAYMENT_REPORTED')
        )
      order by lock_expires_at, id
      for update skip locked
      limit ${limit}
    `);

    for (const order of expiredOrders) {
      await tx
        .update(inventoryReservations)
        .set({
          expiresAt: null,
          releaseReason: "待付款订单超时",
          status: "RELEASED",
          updatedAt: now,
        })
        .where(
          and(
            eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
            eq(inventoryReservations.referenceId, order.id),
            eq(inventoryReservations.status, "ACTIVE"),
          ),
        );
      await tx
        .update(paymentClaims)
        .set({
          rejectionReason: "订单等待付款或核款超时",
          reviewedAt: now,
          status: "REJECTED",
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentClaims.orderId, order.id),
            eq(paymentClaims.status, "PENDING"),
          ),
        );
      await tx
        .update(fulfillmentOrders)
        .set({ lockExpiresAt: null, status: "EXPIRED", updatedAt: now })
        .where(eq(fulfillmentOrders.id, order.id));
      await tx.insert(auditLogs).values({
        action: "FULFILLMENT_ORDER_EXPIRED",
        actorId: null,
        actorType: "SYSTEM",
        afterJson: { status: "EXPIRED" },
        beforeJson: {
          lockExpiresAt: asDate(order.lockExpiresAt)?.toISOString() ?? null,
          status: "PENDING_PAYMENT",
        },
        entityId: order.id,
        entityType: "FULFILLMENT_ORDER",
        reason: "待付款或待核款订单超过库存锁定期限",
      });
      await enqueueCargoSyncEvent(tx, {
        idempotencyKey: `order-expired:${order.id}`,
        now,
        reason: "expired-order-inventory-released",
      });
    }

    return expiredOrders.length;
  });
}
