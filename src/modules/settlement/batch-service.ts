import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  fulfillmentOrders,
  inventoryReservations,
  settlementBatchOrders,
  settlementBatches,
  settlementPaymentClaims,
} from "@/db/schema";
import { createSystemNotification } from "@/modules/notifications/service";
import {
  WalletValidationError,
  consumeWalletHold,
  releaseWalletHold,
} from "@/modules/wallet/service";

const PAYMENT_REVIEW_LOCK_MS = 12 * 60 * 60 * 1000;
const MAX_FEN = 2_147_483_647;

export class SettlementBatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SettlementBatchError";
  }
}

type LockedBatch = {
  closedAt: Date | string | null;
  customerId: string;
  offlineAmountFen: number;
  paidAt: Date | string | null;
  paymentDueAt: Date | string;
  paymentReportedAt: Date | string | null;
  status: string;
  statusReason: string | null;
  totalAmountFen: number;
  walletAmountFen: number;
};

export type SettlementBatchView = {
  claim: {
    amountFen: number;
    id: string;
    status: string;
  } | null;
  closedAt: Date | null;
  customerId: string;
  id: string;
  offlineAmountFen: number;
  paidAt: Date | null;
  paymentDueAt: Date;
  paymentReportedAt: Date | null;
  status: string;
  statusReason: string | null;
  totalAmountFen: number;
  walletAmountFen: number;
};

export type PackageCancellationSettlementPreparation =
  | {
      outcome: "NO_SETTLEMENT";
      settlementBatchId: null;
    }
  | {
      outcome:
        | "ALREADY_INVALIDATED"
        | "INVALIDATED"
        | "PAYMENT_RECONCILIATION_REQUIRED"
        | "TERMINAL";
      settlementBatchId: string;
    };

function asDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function assertFen(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_FEN) {
    throw new SettlementBatchError("INVALID_AMOUNT", "付款金额必须是有效的人民币分整数");
  }
}

function requiredText(
  value: string | undefined,
  code: string,
  message: string,
  maxLength = 1000,
) {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new SettlementBatchError(code, message);
  if (normalized.length > maxLength) {
    throw new SettlementBatchError(`${code}_TOO_LONG`, `${message}，且不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

async function lockBatch(
  tx: DbTransaction,
  settlementBatchId: string,
  customerId?: string,
): Promise<LockedBatch> {
  const customerFilter = customerId ? sql`and customer_id = ${customerId}` : sql``;
  const rows = await tx.execute<LockedBatch>(sql`
    select
      closed_at as "closedAt",
      customer_id as "customerId",
      offline_amount_fen as "offlineAmountFen",
      paid_at as "paidAt",
      payment_due_at as "paymentDueAt",
      payment_reported_at as "paymentReportedAt",
      status,
      status_reason as "statusReason",
      total_amount_fen as "totalAmountFen",
      wallet_amount_fen as "walletAmountFen"
    from settlement_batches
    where id = ${settlementBatchId} ${customerFilter}
    for update
  `);
  const batch = rows[0];
  if (!batch) {
    throw new SettlementBatchError("SETTLEMENT_NOT_FOUND", "未找到该结算批次");
  }
  return batch;
}

async function getBatchView(
  tx: DbTransaction,
  settlementBatchId: string,
): Promise<SettlementBatchView> {
  const [batch] = await tx
    .select()
    .from(settlementBatches)
    .where(eq(settlementBatches.id, settlementBatchId))
    .limit(1);
  if (!batch) throw new SettlementBatchError("SETTLEMENT_NOT_FOUND", "未找到该结算批次");
  const [claim] = await tx
    .select({
      amountFen: settlementPaymentClaims.amountFen,
      id: settlementPaymentClaims.id,
      status: settlementPaymentClaims.status,
    })
    .from(settlementPaymentClaims)
    .where(eq(settlementPaymentClaims.settlementBatchId, settlementBatchId))
    .orderBy(asc(settlementPaymentClaims.createdAt))
    .limit(1);
  return {
    claim: claim ?? null,
    closedAt: batch.closedAt,
    customerId: batch.customerId,
    id: batch.id,
    offlineAmountFen: batch.offlineAmountFen,
    paidAt: batch.paidAt,
    paymentDueAt: batch.paymentDueAt,
    paymentReportedAt: batch.paymentReportedAt,
    status: batch.status,
    statusReason: batch.statusReason,
    totalAmountFen: batch.totalAmountFen,
    walletAmountFen: batch.walletAmountFen,
  };
}

async function batchOrderIds(tx: DbTransaction, settlementBatchId: string) {
  const rows = await tx
    .select({ orderId: settlementBatchOrders.orderId })
    .from(settlementBatchOrders)
    .where(eq(settlementBatchOrders.settlementBatchId, settlementBatchId))
    .orderBy(asc(settlementBatchOrders.orderId));
  if (rows.length === 0) {
    throw new SettlementBatchError("SETTLEMENT_ORDERS_MISSING", "结算批次没有关联拿货单");
  }
  return rows.map((row) => row.orderId);
}

async function assertAllOrdersPending(
  tx: DbTransaction,
  settlementBatchId: string,
) {
  const rows = await tx.execute<{
    cancellationAdjusted: boolean;
    cancellationPending: boolean;
    cancellationState: string;
    id: string;
    status: string;
  }>(sql`
    select
      o.id,
      o.status,
      o.cancellation_state as "cancellationState",
      exists (
        select 1
        from shipment_cancellation_adjustments adjustment
        where adjustment.order_id = o.id
      ) as "cancellationAdjusted",
      exists (
        select 1
        from order_shipments shipment
        inner join shipment_fulfillments fulfillment
          on fulfillment.shipment_id = shipment.id
        where shipment.order_id = o.id
          and fulfillment.status = 'CANCEL_PENDING'
      ) as "cancellationPending"
    from settlement_batch_orders allocation
    inner join fulfillment_orders o on o.id = allocation.order_id
    where allocation.settlement_batch_id = ${settlementBatchId}
    order by o.id
    for update of o
  `);
  if (
    rows.length === 0 ||
    rows.some(
      (row) =>
        row.status !== "PENDING_PAYMENT" ||
        row.cancellationAdjusted ||
        row.cancellationPending ||
        row.cancellationState !== "NONE",
    )
  ) {
    throw new SettlementBatchError(
      "SETTLEMENT_ORDERS_NOT_PENDING",
      "结算批次中的拿货单当前不能申报或审核付款",
    );
  }
}

async function pendingClaim(tx: DbTransaction, settlementBatchId: string) {
  const rows = await tx.execute<{
    amountFen: number;
    id: string;
    status: string;
  }>(sql`
    select id, amount_fen as "amountFen", status
    from settlement_payment_claims
    where settlement_batch_id = ${settlementBatchId}
      and status = 'PENDING'
    order by created_at, id
    for update
  `);
  return rows[0] ?? null;
}

async function auditBatch(
  tx: DbTransaction,
  input: {
    action: string;
    actorId: string | null;
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
    afterJson: Record<string, unknown>;
    beforeJson: Record<string, unknown>;
    reason: string;
    settlementBatchId: string;
  },
) {
  await tx.insert(auditLogs).values({
    action: input.action,
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: input.afterJson,
    beforeJson: input.beforeJson,
    entityId: input.settlementBatchId,
    entityType: "SETTLEMENT_BATCH",
    reason: input.reason,
  });
}

async function notifySettlement(
  tx: DbTransaction,
  input: {
    event: string;
    message: string;
    now: Date;
    settlementBatchId: string;
    severity: "INFO" | "WARNING" | "ERROR";
    title: string;
  },
) {
  await createSystemNotification(tx, {
    deduplicationKey: `settlement:${input.event}:${input.settlementBatchId}`,
    entityId: input.settlementBatchId,
    entityType: "SETTLEMENT_BATCH",
    message: input.message,
    now: input.now,
    severity: input.severity,
    title: input.title,
    type: `SETTLEMENT_${input.event.toUpperCase()}`,
  });
}

/**
 * Invalidates an unpaid unified-settlement quote before a package cancellation.
 *
 * Settlement totals and per-order allocations are checkout snapshots. Mutating them
 * in place would make audit history ambiguous and cannot represent a zero-value
 * allocation with the current schema. A package-level price change therefore closes
 * the unpaid quote and releases its wallet hold. The still-active orders remain
 * PENDING_PAYMENT and can be paid independently at their adjusted payable amounts.
 *
 * Call this only in the transaction that finalizes a confirmed cancellation.
 * Remote cancellation claims use assertSettlementAllowsPackageCancellation first,
 * leaving the quote and wallet hold intact if the third-party request fails.
 */
export async function prepareSettlementForPackageCancellation(
  tx: DbTransaction,
  input: {
    actorId: string | null;
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
    now: Date;
    orderId: string;
    reason: string;
  },
): Promise<PackageCancellationSettlementPreparation> {
  const reason = requiredText(
    input.reason,
    "PACKAGE_CANCELLATION_REASON_REQUIRED",
    "取消包裹必须填写原因",
  );
  const [reference] = await tx
    .select({ settlementBatchId: settlementBatchOrders.settlementBatchId })
    .from(settlementBatchOrders)
    .where(eq(settlementBatchOrders.orderId, input.orderId))
    .limit(1);
  if (!reference) {
    return { outcome: "NO_SETTLEMENT", settlementBatchId: null };
  }

  const batch = await lockBatch(tx, reference.settlementBatchId);
  if (batch.status === "PAYMENT_REPORTED") {
    throw new SettlementBatchError(
      "SETTLEMENT_PAYMENT_REPORTED_CANCELLATION_BLOCKED",
      "该包裹所属统一结算已申报付款，请先撤回整笔付款声明再取消包裹",
    );
  }
  if (batch.status === "PAID") {
    return {
      outcome: "TERMINAL",
      settlementBatchId: reference.settlementBatchId,
    };
  }
  if (batch.status === "CANCELLED") {
    return {
      outcome: "ALREADY_INVALIDATED",
      settlementBatchId: reference.settlementBatchId,
    };
  }
  if (batch.status !== "PENDING_PAYMENT") {
    return {
      outcome: "TERMINAL",
      settlementBatchId: reference.settlementBatchId,
    };
  }

  const claim = await pendingClaim(tx, reference.settlementBatchId);
  if (claim) {
    throw new SettlementBatchError(
      "SETTLEMENT_STATE_INVALID",
      "统一结算付款状态异常，取消包裹前需要人工核对",
    );
  }
  const invalidationReason = `包裹取消导致统一结算报价失效：${reason}`;
  if (batch.walletAmountFen > 0) {
    await releaseWalletHold(tx, {
      actorType: input.actorType,
      actorUserId: input.actorId ?? "package-cancellation-system",
      customerId: batch.customerId,
      now: input.now,
      reason: invalidationReason,
      settlementBatchId: reference.settlementBatchId,
    });
  }
  await tx
    .update(settlementBatches)
    .set({
      closedAt: input.now,
      status: "CANCELLED",
      statusReason: invalidationReason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(settlementBatches.id, reference.settlementBatchId),
        eq(settlementBatches.status, "PENDING_PAYMENT"),
      ),
    );
  await auditBatch(tx, {
    action: "SETTLEMENT_INVALIDATED_BY_PACKAGE_CANCELLATION",
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: {
      status: "CANCELLED",
      walletHoldReleasedFen: batch.walletAmountFen,
    },
    beforeJson: {
      offlineAmountFen: batch.offlineAmountFen,
      status: batch.status,
      totalAmountFen: batch.totalAmountFen,
      walletAmountFen: batch.walletAmountFen,
    },
    reason: invalidationReason,
    settlementBatchId: reference.settlementBatchId,
  });
  await notifySettlement(tx, {
    event: "package-cancellation-invalidated",
    message: "包裹取消使原统一结算金额失效，钱包冻结已释放；其余拿货单请按当前应付金额重新付款。",
    now: input.now,
    settlementBatchId: reference.settlementBatchId,
    severity: "WARNING",
    title: "统一结算已失效",
  });
  return {
    outcome: "INVALIDATED",
    settlementBatchId: reference.settlementBatchId,
  };
}

/**
 * Reconciles funding after Jifeng has already confirmed a normal package as
 * cancelled. Unlike an operator-requested cancellation, this path cannot reject
 * the remote fact. An unpaid quote is invalidated; a reported payment remains
 * frozen for explicit whole-batch review and emits an error notification.
 */
export async function prepareSettlementForConfirmedRemoteCancellation(
  tx: DbTransaction,
  input: {
    now: Date;
    orderId: string;
    reason: string;
  },
): Promise<PackageCancellationSettlementPreparation> {
  const [reference] = await tx
    .select({ settlementBatchId: settlementBatchOrders.settlementBatchId })
    .from(settlementBatchOrders)
    .where(eq(settlementBatchOrders.orderId, input.orderId))
    .limit(1);
  if (!reference) {
    return { outcome: "NO_SETTLEMENT", settlementBatchId: null };
  }
  const batch = await lockBatch(tx, reference.settlementBatchId);
  if (batch.status !== "PAYMENT_REPORTED") {
    return prepareSettlementForPackageCancellation(tx, {
      actorId: null,
      actorType: "SYSTEM",
      now: input.now,
      orderId: input.orderId,
      reason: input.reason,
    });
  }
  await notifySettlement(tx, {
    event: "remote-cancellation-reconciliation-required",
    message:
      "极风已取消统一结算中的包裹，但整批付款正在审核。系统已停止批准该旧金额，请人工撤回或驳回整批付款并重新结算。",
    now: input.now,
    settlementBatchId: reference.settlementBatchId,
    severity: "ERROR",
    title: "统一结算需要人工对账",
  });
  return {
    outcome: "PAYMENT_RECONCILIATION_REQUIRED",
    settlementBatchId: reference.settlementBatchId,
  };
}

/**
 * Serializes payment declaration against a remote package-cancellation claim
 * without changing the quote. The quote is invalidated only after Jifeng has
 * confirmed the cancellation, so a failed remote request leaves funding intact.
 */
export async function assertSettlementAllowsPackageCancellation(
  tx: DbTransaction,
  orderId: string,
) {
  const [reference] = await tx
    .select({ settlementBatchId: settlementBatchOrders.settlementBatchId })
    .from(settlementBatchOrders)
    .where(eq(settlementBatchOrders.orderId, orderId))
    .limit(1);
  if (!reference) return;
  const batch = await lockBatch(tx, reference.settlementBatchId);
  if (batch.status === "PAYMENT_REPORTED") {
    throw new SettlementBatchError(
      "SETTLEMENT_PAYMENT_REPORTED_CANCELLATION_BLOCKED",
      "该包裹所属统一结算已申报付款，请先撤回整笔付款声明再取消包裹",
    );
  }
}

export async function reportSettlementPayment(input: {
  actorUserId: string;
  amountFen: number;
  customerId: string;
  note?: string;
  now?: Date;
  settlementBatchId: string;
}): Promise<SettlementBatchView> {
  assertFen(input.amountFen);
  const actorUserId = requiredText(
    input.actorUserId,
    "ACTOR_REQUIRED",
    "付款声明人不能为空",
    160,
  );
  const note = input.note?.trim() || null;
  if (note && note.length > 500) {
    throw new SettlementBatchError("NOTE_TOO_LONG", "付款备注不能超过 500 个字符");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, input.settlementBatchId, input.customerId);
    if (batch.status === "PAID" || batch.offlineAmountFen === 0) {
      throw new SettlementBatchError("SETTLEMENT_ALREADY_PAID", "该结算批次无需申报线下付款");
    }
    if (batch.status === "PAYMENT_REPORTED") {
      const claim = await pendingClaim(tx, input.settlementBatchId);
      if (!claim) {
        throw new SettlementBatchError("SETTLEMENT_STATE_INVALID", "结算批次付款状态异常");
      }
      if (claim.amountFen !== input.amountFen) {
        throw new SettlementBatchError(
          "PAYMENT_AMOUNT_MISMATCH",
          "申报金额必须与结算批次线下待付金额一致",
        );
      }
      return getBatchView(tx, input.settlementBatchId);
    }
    if (batch.status !== "PENDING_PAYMENT") {
      throw new SettlementBatchError("SETTLEMENT_NOT_REPORTABLE", "该结算批次当前不能申报付款");
    }
    const paymentDueAt = asDate(batch.paymentDueAt)!;
    if (paymentDueAt <= now) {
      throw new SettlementBatchError("SETTLEMENT_PAYMENT_EXPIRED", "结算批次付款期限已过");
    }
    if (batch.offlineAmountFen !== input.amountFen) {
      throw new SettlementBatchError(
        "PAYMENT_AMOUNT_MISMATCH",
        "申报金额必须与结算批次线下待付金额一致",
      );
    }
    await assertAllOrdersPending(tx, input.settlementBatchId);
    const orderIds = await batchOrderIds(tx, input.settlementBatchId);
    const reviewDueAt = new Date(now.getTime() + PAYMENT_REVIEW_LOCK_MS);
    await tx.insert(settlementPaymentClaims).values({
      amountFen: input.amountFen,
      customerId: input.customerId,
      note,
      settlementBatchId: input.settlementBatchId,
    });
    await tx
      .update(settlementBatches)
      .set({ paymentReportedAt: now, status: "PAYMENT_REPORTED", updatedAt: now })
      .where(eq(settlementBatches.id, input.settlementBatchId));
    await tx
      .update(fulfillmentOrders)
      .set({ lockExpiresAt: reviewDueAt, paymentDeclaredAt: now, updatedAt: now })
      .where(inArray(fulfillmentOrders.id, orderIds));
    await tx
      .update(inventoryReservations)
      .set({ expiresAt: reviewDueAt, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          inArray(inventoryReservations.referenceId, orderIds),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    await auditBatch(tx, {
      action: "SETTLEMENT_PAYMENT_REPORTED",
      actorId: actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        amountFen: input.amountFen,
        reviewDueAt: reviewDueAt.toISOString(),
        status: "PAYMENT_REPORTED",
      },
      beforeJson: { status: "PENDING_PAYMENT" },
      reason: "客户声明结算批次微信线下款已支付",
      settlementBatchId: input.settlementBatchId,
    });
    await notifySettlement(tx, {
      event: "payment-reported",
      message: "客户已提交一笔结算批次付款声明，请登录系统核款。",
      now,
      settlementBatchId: input.settlementBatchId,
      severity: "INFO",
      title: "结算批次等待核款",
    });
    return getBatchView(tx, input.settlementBatchId);
  });
}

async function releaseTerminalBatch(
  tx: DbTransaction,
  input: {
    actorId: string;
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
    batch: LockedBatch;
    now: Date;
    orderStatus: "CANCELLED" | "EXPIRED";
    reason: string;
    settlementBatchId: string;
    status: "REJECTED" | "WITHDRAWN" | "EXPIRED";
  },
) {
  const orderIds = await batchOrderIds(tx, input.settlementBatchId);
  if (input.batch.walletAmountFen > 0) {
    await releaseWalletHold(tx, {
      actorType: input.actorType,
      actorUserId: input.actorId,
      customerId: input.batch.customerId,
      now: input.now,
      reason: input.reason,
      settlementBatchId: input.settlementBatchId,
    });
  }
  await tx
    .update(inventoryReservations)
    .set({
      expiresAt: null,
      releaseReason: input.reason,
      status: "RELEASED",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
        inArray(inventoryReservations.referenceId, orderIds),
        eq(inventoryReservations.status, "ACTIVE"),
      ),
    );
  await tx
    .update(fulfillmentOrders)
    .set(
      input.orderStatus === "CANCELLED"
        ? {
            cancelReason: input.reason,
            cancellationState: "ALL" as const,
            cancelledAt: input.now,
            lockExpiresAt: null,
            status: "CANCELLED",
            updatedAt: input.now,
          }
        : {
            lockExpiresAt: null,
            status: "EXPIRED",
            updatedAt: input.now,
          },
    )
    .where(
      and(
        inArray(fulfillmentOrders.id, orderIds),
        eq(fulfillmentOrders.status, "PENDING_PAYMENT"),
      ),
    );
  await tx
    .update(settlementBatches)
    .set({
      closedAt: input.now,
      status: input.status,
      statusReason: input.reason,
      updatedAt: input.now,
    })
    .where(eq(settlementBatches.id, input.settlementBatchId));
  await auditBatch(tx, {
    action: `SETTLEMENT_${input.status}`,
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: { orderStatus: input.orderStatus, status: input.status },
    beforeJson: { status: input.batch.status },
    reason: input.reason,
    settlementBatchId: input.settlementBatchId,
  });
  await notifySettlement(tx, {
    event: input.status.toLowerCase(),
    message: `结算批次已${input.status === "EXPIRED" ? "超时关闭" : "关闭"}，请登录系统查看原因。`,
    now: input.now,
    settlementBatchId: input.settlementBatchId,
    severity: input.status === "EXPIRED" ? "WARNING" : "INFO",
    title: "结算批次状态已更新",
  });
}

const REPORTED_PAYMENT_TIMEOUT_REASON = "付款声明超过 12 小时未完成核款";

function reportedPaymentDeadlineReached(batch: LockedBatch, now: Date) {
  const reportedAt = asDate(batch.paymentReportedAt);
  return (
    batch.status === "PAYMENT_REPORTED" &&
    reportedAt !== null &&
    reportedAt.getTime() + PAYMENT_REVIEW_LOCK_MS <= now.getTime()
  );
}

async function expireLockedReportedBatch(
  tx: DbTransaction,
  batch: LockedBatch,
  settlementBatchId: string,
  now: Date,
) {
  const claim = await pendingClaim(tx, settlementBatchId);
  if (!claim) {
    throw new SettlementBatchError("PAYMENT_CLAIM_NOT_FOUND", "超时结算批次缺少待审核付款声明");
  }
  await tx
    .update(settlementPaymentClaims)
    .set({
      rejectionReason: REPORTED_PAYMENT_TIMEOUT_REASON,
      reviewedAt: now,
      reviewedByAdminUserId: null,
      status: "REJECTED",
      updatedAt: now,
    })
    .where(eq(settlementPaymentClaims.id, claim.id));
  await releaseTerminalBatch(tx, {
    actorId: "settlement-timeout-worker",
    actorType: "SYSTEM",
    batch,
    now,
    orderStatus: "EXPIRED",
    reason: REPORTED_PAYMENT_TIMEOUT_REASON,
    settlementBatchId,
    status: "EXPIRED",
  });
}

function throwReviewDeadlineExpired(): never {
  throw new SettlementBatchError(
    "SETTLEMENT_REVIEW_DEADLINE_EXPIRED",
    "付款声明已超过 12 小时审核期限并被系统关闭",
  );
}

export async function withdrawSettlementPayment(input: {
  actorUserId: string;
  customerId: string;
  now?: Date;
  reason: string;
  settlementBatchId: string;
}): Promise<SettlementBatchView> {
  const actorUserId = requiredText(input.actorUserId, "ACTOR_REQUIRED", "撤回人不能为空", 160);
  const reason = requiredText(
    input.reason,
    "WITHDRAWAL_REASON_REQUIRED",
    "撤回付款声明必须填写原因",
  );
  const now = input.now ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const batch = await lockBatch(tx, input.settlementBatchId, input.customerId);
    if (batch.status === "WITHDRAWN") {
      if (batch.statusReason !== reason) {
        throw new SettlementBatchError("SETTLEMENT_ALREADY_CLOSED", "结算批次已按其他原因关闭");
      }
      return getBatchView(tx, input.settlementBatchId);
    }
    if (batch.status !== "PAYMENT_REPORTED") {
      throw new SettlementBatchError("SETTLEMENT_NOT_WITHDRAWABLE", "该结算批次当前不能撤回付款声明");
    }
    if (reportedPaymentDeadlineReached(batch, now)) {
      await expireLockedReportedBatch(tx, batch, input.settlementBatchId, now);
      return { deadlineExpired: true as const };
    }
    const claim = await pendingClaim(tx, input.settlementBatchId);
    if (!claim) throw new SettlementBatchError("PAYMENT_CLAIM_NOT_FOUND", "未找到待审核付款声明");
    await tx
      .update(settlementPaymentClaims)
      .set({
        status: "WITHDRAWN",
        updatedAt: now,
        withdrawalReason: reason,
        withdrawnAt: now,
      })
      .where(eq(settlementPaymentClaims.id, claim.id));
    await releaseTerminalBatch(tx, {
      actorId: actorUserId,
      actorType: "CUSTOMER",
      batch,
      now,
      orderStatus: "CANCELLED",
      reason,
      settlementBatchId: input.settlementBatchId,
      status: "WITHDRAWN",
    });
    return getBatchView(tx, input.settlementBatchId);
  });
  if ("deadlineExpired" in outcome && outcome.deadlineExpired) {
    throwReviewDeadlineExpired();
  }
  return outcome as SettlementBatchView;
}

async function assertActiveAdmin(tx: DbTransaction, adminUserId: string) {
  const [admin] = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.id, adminUserId), eq(adminUsers.status, "ACTIVE")))
    .limit(1);
  if (!admin) throw new SettlementBatchError("ADMIN_FORBIDDEN", "管理员账号无权审核付款声明");
}

export async function reviewSettlementPayment(input: {
  adminUserId: string;
  decision: "APPROVE" | "REJECT";
  now?: Date;
  rejectionReason?: string;
  settlementBatchId: string;
}): Promise<void> {
  const adminUserId = requiredText(input.adminUserId, "ADMIN_REQUIRED", "审核管理员不能为空", 160);
  const rejectionReason =
    input.decision === "REJECT"
      ? requiredText(
          input.rejectionReason,
          "REJECTION_REASON_REQUIRED",
          "拒绝付款声明必须填写原因",
        )
      : null;
  const now = input.now ?? new Date();

  const outcome = await db.transaction(async (tx) => {
    await assertActiveAdmin(tx, adminUserId);
    const batch = await lockBatch(tx, input.settlementBatchId);
    if (input.decision === "APPROVE" && batch.status === "PAID") return;
    if (
      input.decision === "REJECT" &&
      batch.status === "REJECTED" &&
      batch.statusReason === rejectionReason
    ) {
      return;
    }
    if (batch.status !== "PAYMENT_REPORTED") {
      throw new SettlementBatchError("SETTLEMENT_NOT_REVIEWABLE", "该结算批次当前不能核款");
    }
    if (reportedPaymentDeadlineReached(batch, now)) {
      await expireLockedReportedBatch(tx, batch, input.settlementBatchId, now);
      return "DEADLINE_EXPIRED" as const;
    }
    const claim = await pendingClaim(tx, input.settlementBatchId);
    if (!claim) throw new SettlementBatchError("PAYMENT_CLAIM_NOT_FOUND", "未找到待审核付款声明");
    if (claim.amountFen !== batch.offlineAmountFen) {
      throw new SettlementBatchError("PAYMENT_AMOUNT_MISMATCH", "付款声明金额与线下待付金额不一致");
    }
    if (input.decision === "REJECT") {
      await tx
        .update(settlementPaymentClaims)
        .set({
          rejectionReason,
          reviewedAt: now,
          reviewedByAdminUserId: adminUserId,
          status: "REJECTED",
          updatedAt: now,
        })
        .where(eq(settlementPaymentClaims.id, claim.id));
      await releaseTerminalBatch(tx, {
        actorId: adminUserId,
        actorType: "ADMIN",
        batch,
        now,
        orderStatus: "CANCELLED",
        reason: rejectionReason!,
        settlementBatchId: input.settlementBatchId,
        status: "REJECTED",
      });
      return;
    }

    await assertAllOrdersPending(tx, input.settlementBatchId);
    if (batch.walletAmountFen > 0) {
      try {
        await consumeWalletHold(tx, {
          actorType: "ADMIN",
          actorUserId: adminUserId,
          customerId: batch.customerId,
          now,
          settlementBatchId: input.settlementBatchId,
        });
      } catch (error) {
        if (error instanceof WalletValidationError) {
          throw new SettlementBatchError("WALLET_HOLD_INVALID", "结算批次余额冻结无法核销");
        }
        throw error;
      }
    }
    const orderIds = await batchOrderIds(tx, input.settlementBatchId);
    const paymentMode = batch.walletAmountFen > 0 ? "MIXED" : "DIRECT_OFFLINE";
    await tx
      .update(settlementPaymentClaims)
      .set({
        rejectionReason: null,
        reviewedAt: now,
        reviewedByAdminUserId: adminUserId,
        status: "APPROVED",
        updatedAt: now,
      })
      .where(eq(settlementPaymentClaims.id, claim.id));
    await tx
      .update(fulfillmentOrders)
      .set({
        lockExpiresAt: null,
        paidAt: now,
        paymentMode,
        status: "PAID_PENDING_FULFILLMENT",
        updatedAt: now,
      })
      .where(inArray(fulfillmentOrders.id, orderIds));
    await tx
      .update(inventoryReservations)
      .set({ expiresAt: null, updatedAt: now })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          inArray(inventoryReservations.referenceId, orderIds),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    await tx
      .update(settlementBatches)
      .set({ paidAt: now, status: "PAID", statusReason: null, updatedAt: now })
      .where(eq(settlementBatches.id, input.settlementBatchId));
    await auditBatch(tx, {
      action: "SETTLEMENT_PAYMENT_APPROVED",
      actorId: adminUserId,
      actorType: "ADMIN",
      afterJson: { orderStatus: "PAID_PENDING_FULFILLMENT", status: "PAID" },
      beforeJson: { status: "PAYMENT_REPORTED" },
      reason: "管理员确认结算批次微信线下付款到账",
      settlementBatchId: input.settlementBatchId,
    });
    await notifySettlement(tx, {
      event: "payment-approved",
      message: "结算批次已确认收款，相关拿货单已进入待发货。",
      now,
      settlementBatchId: input.settlementBatchId,
      severity: "INFO",
      title: "结算批次已付款",
    });
  });
  if (outcome === "DEADLINE_EXPIRED") throwReviewDeadlineExpired();
  if (input.decision === "APPROVE") {
    const { enqueuePaidOrdersForFulfillment } = await import(
      "@/modules/fulfillment/dispatch"
    );
    await enqueuePaidOrdersForFulfillment({ now });
  }
}

async function expireLockedSettlementBatch(
  tx: DbTransaction,
  batch: LockedBatch,
  settlementBatchId: string,
  now: Date,
) {
    const paymentDueAt = asDate(batch.paymentDueAt)!;
    const isUnreportedExpired = batch.status === "PENDING_PAYMENT" && paymentDueAt <= now;
    const isReportedExpired = reportedPaymentDeadlineReached(batch, now);
    if (!isUnreportedExpired && !isReportedExpired) return false;
    if (isReportedExpired) {
      await expireLockedReportedBatch(tx, batch, settlementBatchId, now);
      return true;
    }
    const reason = "结算批次超过 2 小时未申报付款";
    await releaseTerminalBatch(tx, {
      actorId: "settlement-timeout-worker",
      actorType: "SYSTEM",
      batch,
      now,
      orderStatus: "EXPIRED",
      reason,
      settlementBatchId,
      status: "EXPIRED",
    });
    return true;
}

export async function expireSettlementBatches(now: Date = new Date()): Promise<number> {
  const reportedCutoff = new Date(now.getTime() - PAYMENT_REVIEW_LOCK_MS);
  let expired = 0;
  for (let processed = 0; processed < 100; processed += 1) {
    const result = await db.transaction(async (tx) => {
      const candidates = await tx.execute<{ id: string }>(sql`
        select id
        from settlement_batches
        where (status = 'PENDING_PAYMENT' and payment_due_at <= ${now.toISOString()}::timestamptz)
           or (status = 'PAYMENT_REPORTED' and payment_reported_at <= ${reportedCutoff.toISOString()}::timestamptz)
        order by coalesce(payment_reported_at, payment_due_at), id
        for update skip locked
        limit 1
      `);
      const candidate = candidates[0];
      if (!candidate) return "NONE" as const;
      const batch = await lockBatch(tx, candidate.id);
      return (await expireLockedSettlementBatch(tx, batch, candidate.id, now))
        ? ("EXPIRED" as const)
        : ("SKIPPED" as const);
    });
    if (result === "NONE") break;
    if (result === "EXPIRED") expired += 1;
  }
  return expired;
}
