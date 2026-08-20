import { and, eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  orderLines,
  orderShipments,
  paymentClaims,
  settlementBatchOrders,
  settlementBatches,
  shipmentCancellationAdjustments,
  walletTransactions,
} from "@/db/schema";
import { PACKAGE_SHIPPING_FEE_FEN } from "@/modules/orders/pricing";
import { refundWalletForShipment } from "@/modules/wallet/service";

type CancellationActor = {
  actorId: string | null;
  actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
};

export class PackageCancellationAdjustmentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PackageCancellationAdjustmentError";
  }
}

export async function assertPackageCancellationFinanciallyAllowed(
  tx: DbTransaction,
  orderId: string,
) {
  const settlementRows = await tx
    .select({ id: settlementBatches.id, status: settlementBatches.status })
    .from(settlementBatches)
    .innerJoin(
      settlementBatchOrders,
      eq(settlementBatchOrders.settlementBatchId, settlementBatches.id),
    )
    .where(eq(settlementBatchOrders.orderId, orderId))
    .for("update", { of: settlementBatches })
    .limit(1);
  if (
    settlementRows[0] &&
    ["PENDING_PAYMENT", "PAYMENT_REPORTED"].includes(settlementRows[0].status)
  ) {
    throw new PackageCancellationAdjustmentError(
      "ACTIVE_SETTLEMENT_REPRICING_REQUIRED",
      "该包裹属于未完成的统一结算批次，请先撤回或关闭该结算批次后再取消包裹",
    );
  }
}

export async function completeOfflinePackageRefund(input: {
  actorUserId: string;
  adjustmentId: string;
  adminUserId: string;
  note: string;
  now?: Date;
}) {
  const note = input.note.trim();
  if (!note) {
    throw new PackageCancellationAdjustmentError(
      "COMPLETION_NOTE_REQUIRED",
      "确认线下退款必须填写凭证或备注",
    );
  }
  if (note.length > 1000) {
    throw new PackageCancellationAdjustmentError(
      "COMPLETION_NOTE_TOO_LONG",
      "线下退款备注不能超过 1000 个字符",
    );
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      offlineAmountFen: number;
      orderId: string;
      shipmentId: string;
      status: string;
    }>(sql`
      select
        offline_amount_fen as "offlineAmountFen",
        order_id as "orderId",
        shipment_id as "shipmentId",
        status
      from shipment_cancellation_adjustments
      where id = ${input.adjustmentId}
      for update
    `);
    const adjustment = rows[0];
    if (!adjustment) {
      throw new PackageCancellationAdjustmentError(
        "ADJUSTMENT_NOT_FOUND",
        "未找到包裹取消退款记录",
      );
    }
    if (adjustment.status === "COMPLETED") {
      return { orderId: adjustment.orderId, status: "ALREADY_COMPLETED" as const };
    }
    if (adjustment.status !== "PENDING_OFFLINE" || adjustment.offlineAmountFen <= 0) {
      throw new PackageCancellationAdjustmentError(
        "OFFLINE_REFUND_NOT_PENDING",
        "该包裹没有待处理的线下退款",
      );
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
      .where(eq(shipmentCancellationAdjustments.id, input.adjustmentId));
    await tx.insert(auditLogs).values({
      action: "SHIPMENT_OFFLINE_REFUND_COMPLETED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {
        completedAt: now.toISOString(),
        note,
        offlineAmountFen: adjustment.offlineAmountFen,
        status: "COMPLETED",
      },
      beforeJson: { status: "PENDING_OFFLINE" },
      entityId: adjustment.shipmentId,
      entityType: "ORDER_SHIPMENT",
      reason: note,
    });
    return { orderId: adjustment.orderId, status: "COMPLETED" as const };
  });
}

export async function recordPackageCancellationAdjustment(
  tx: DbTransaction,
  input: CancellationActor & {
    financialAuthorization?: "CONFIRMED_REMOTE_CANCELLATION";
    now: Date;
    orderId: string;
    reason: string;
    shipmentId: string;
  },
) {
  // Settlement batches are always locked before their orders. Keeping that
  // canonical order avoids deadlocks with payment review and batch closure.
  if (input.financialAuthorization !== "CONFIRMED_REMOTE_CANCELLATION") {
    await assertPackageCancellationFinanciallyAllowed(tx, input.orderId);
  }

  const rows = await tx.execute<{
    customerId: string;
    kind: string;
    paymentMode: string | null;
    totalAmountFen: number;
  }>(sql`
    select
      o.customer_id as "customerId",
      s.kind,
      o.payment_mode as "paymentMode",
      o.total_amount_fen as "totalAmountFen"
    from order_shipments s
    inner join fulfillment_orders o on o.id = s.order_id
    where s.id = ${input.shipmentId}
      and o.id = ${input.orderId}
    for update of s, o
  `);
  const row = rows[0];
  if (!row) throw new Error("取消包裹不存在或不属于当前拿货单");
  if (row.kind !== "NORMAL") return null;

  // The active unique indexes implement duplicate-import protection. A normal
  // package that is confirmed cancelled must release only its own keys so the
  // customer can import that package again without reopening sibling packages.
  await tx
    .update(orderShipments)
    .set({ deduplicationActive: false, updatedAt: input.now })
    .where(eq(orderShipments.id, input.shipmentId));
  await tx
    .update(orderLines)
    .set({ deduplicationActive: false })
    .where(eq(orderLines.shipmentId, input.shipmentId));

  const [existingAfterLock] = await tx
    .select()
    .from(shipmentCancellationAdjustments)
    .where(eq(shipmentCancellationAdjustments.shipmentId, input.shipmentId))
    .limit(1);
  if (existingAfterLock) return existingAfterLock;

  const merchandiseRows = await tx.execute<{ amountFen: number }>(sql`
    select coalesce(sum(line_amount_fen), 0)::int as "amountFen"
    from order_lines
    where shipment_id = ${input.shipmentId}
      and order_id = ${input.orderId}
  `);
  const merchandiseAmountFen = merchandiseRows[0]?.amountFen ?? 0;
  const shippingFeeFen = PACKAGE_SHIPPING_FEE_FEN;
  const totalAmountFen = merchandiseAmountFen + shippingFeeFen;
  if (!Number.isSafeInteger(totalAmountFen) || totalAmountFen <= 0) {
    throw new Error("取消包裹金额无效");
  }

  const priorRows = await tx.execute<{
    totalAmountFen: number;
    walletAmountFen: number;
  }>(sql`
    select
      coalesce(sum(total_amount_fen), 0)::int as "totalAmountFen",
      coalesce(sum(wallet_amount_fen), 0)::int as "walletAmountFen"
    from shipment_cancellation_adjustments
    where order_id = ${input.orderId}
  `);
  const priorTotalFen = priorRows[0]?.totalAmountFen ?? 0;
  const priorWalletFen = priorRows[0]?.walletAmountFen ?? 0;
  const cumulativeTotalFen = priorTotalFen + totalAmountFen;
  if (cumulativeTotalFen > row.totalAmountFen) {
    throw new Error("包裹取消累计金额超过拿货单原始总额");
  }

  let walletAmountFen = 0;
  let offlineAmountFen = 0;
  let status: "COMPLETED" | "NOT_PAID" | "PENDING_OFFLINE" = "NOT_PAID";
  if (row.paymentMode) {
    const debitRows = await tx
      .select({ deltaFen: walletTransactions.deltaFen })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.orderId, input.orderId),
          eq(walletTransactions.transactionType, "ORDER_DEBIT"),
        ),
      )
      .limit(1);
    const walletPaidFen = -(debitRows[0]?.deltaFen ?? 0);
    if (row.paymentMode !== "DIRECT_OFFLINE" && walletPaidFen <= 0) {
      throw new Error("已付款拿货单缺少原始钱包扣款");
    }
    const targetCumulativeWalletFen =
      cumulativeTotalFen === row.totalAmountFen
        ? walletPaidFen
        : Number(
            (BigInt(cumulativeTotalFen) * BigInt(walletPaidFen)) /
              BigInt(row.totalAmountFen),
          );
    walletAmountFen = targetCumulativeWalletFen - priorWalletFen;
    offlineAmountFen = totalAmountFen - walletAmountFen;
    if (walletAmountFen < 0 || offlineAmountFen < 0) {
      throw new Error("包裹取消退款分配无效");
    }
    if (walletAmountFen > 0) {
      await refundWalletForShipment(tx, {
        actorType: input.actorType,
        actorUserId: input.actorId,
        amountFen: walletAmountFen,
        customerId: row.customerId,
        orderId: input.orderId,
        reason: `包裹取消退款：${input.reason}`,
        shipmentId: input.shipmentId,
      });
    }
    status = offlineAmountFen > 0 ? "PENDING_OFFLINE" : "COMPLETED";
  }

  const inserted = await tx
    .insert(shipmentCancellationAdjustments)
    .values({
      actorId: input.actorId,
      actorType: input.actorType,
      createdAt: input.now,
      customerId: row.customerId,
      merchandiseAmountFen,
      offlineAmountFen,
      orderId: input.orderId,
      reason: input.reason,
      shipmentId: input.shipmentId,
      shippingFeeFen,
      status,
      totalAmountFen,
      updatedAt: input.now,
      walletAmountFen,
    })
    .returning();
  if (!row.paymentMode) {
    const invalidatedClaims = await tx
      .update(paymentClaims)
      .set({
        rejectionReason: "包裹取消后应付金额已变更，请按新金额重新申报",
        reviewedAt: input.now,
        reviewedByAdminUserId: null,
        status: "REJECTED",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(paymentClaims.orderId, input.orderId),
          eq(paymentClaims.status, "PENDING"),
        ),
      )
      .returning({ id: paymentClaims.id });
    if (invalidatedClaims.length > 0) {
      await tx
        .update(fulfillmentOrders)
        .set({ paymentDeclaredAt: null, updatedAt: input.now })
        .where(eq(fulfillmentOrders.id, input.orderId));
      await tx.insert(auditLogs).values({
        action: "OFFLINE_PAYMENT_CLAIM_INVALIDATED_BY_SHIPMENT_CANCELLATION",
        actorId: input.actorId,
        actorType: input.actorType,
        afterJson: {
          claimIds: invalidatedClaims.map(({ id }) => id),
          status: "REJECTED",
        },
        beforeJson: { status: "PENDING" },
        entityId: input.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: "包裹取消后应付金额已变更",
      });
    }
  }
  await tx.insert(auditLogs).values({
    action: "SHIPMENT_CANCELLATION_ADJUSTMENT_CREATED",
    actorId: input.actorId,
    actorType: input.actorType,
    afterJson: {
      merchandiseAmountFen,
      offlineAmountFen,
      paymentStatus: status,
      shippingFeeFen,
      totalAmountFen,
      walletAmountFen,
    },
    beforeJson: {},
    entityId: input.shipmentId,
    entityType: "ORDER_SHIPMENT",
    reason: input.reason,
  });
  return inserted[0];
}
