import { and, asc, desc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  customers,
  fulfillmentOrders,
  settlementBatchOrders,
  settlementBatches,
  settlementPaymentClaims,
  stores,
  walletHolds,
} from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import {
  getAdminSettlementBatchStatusLabel,
  getAdminSettlementAuditActionLabel,
  getAdminSettlementClaimStatusLabel,
  getAdminSettlementOrderStatusLabel,
  getAdminWalletHoldStatusLabel,
} from "./admin-ui-labels";

export type AdminSettlementBatchFilters = {
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  storeId?: string;
};

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function listAdminSettlementBatches(
  filters: AdminSettlementBatchFilters = {},
) {
  await requireAdmin();

  const conditions: SQL[] = [];
  if (filters.customerId) {
    conditions.push(eq(settlementBatches.customerId, filters.customerId));
  }
  if (filters.status) conditions.push(eq(settlementBatches.status, filters.status as never));
  if (filters.storeId) {
    conditions.push(
      exists(
        db
          .select({ orderId: settlementBatchOrders.orderId })
          .from(settlementBatchOrders)
          .innerJoin(
            fulfillmentOrders,
            eq(fulfillmentOrders.id, settlementBatchOrders.orderId),
          )
          .where(
            and(
              eq(settlementBatchOrders.settlementBatchId, settlementBatches.id),
              eq(fulfillmentOrders.storeId, filters.storeId),
            ),
          ),
      ),
    );
  }
  if (filters.dateFrom && isIsoDate(filters.dateFrom)) {
    conditions.push(
      sql`(${settlementBatches.createdAt} at time zone ${BUSINESS_TIME_ZONE})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo && isIsoDate(filters.dateTo)) {
    conditions.push(
      sql`(${settlementBatches.createdAt} at time zone ${BUSINESS_TIME_ZONE})::date <= ${filters.dateTo}::date`,
    );
  }

  const rows = await db
    .select({
      batchNumber: settlementBatches.batchNumber,
      createdAt: settlementBatches.createdAt,
      customerCode: customers.code,
      customerId: customers.id,
      customerName: customers.name,
      id: settlementBatches.id,
      offlineAmountFen: settlementBatches.offlineAmountFen,
      paymentDueAt: settlementBatches.paymentDueAt,
      paymentReportedAt: settlementBatches.paymentReportedAt,
      status: settlementBatches.status,
      totalAmountFen: settlementBatches.totalAmountFen,
      walletAmountFen: settlementBatches.walletAmountFen,
    })
    .from(settlementBatches)
    .innerJoin(customers, eq(customers.id, settlementBatches.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(settlementBatches.createdAt))
    .limit(50);

  const batchIds = rows.map((row) => row.id);
  const [counts, storeRows] =
    batchIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              count: settlementBatchOrders.orderId,
              settlementBatchId: settlementBatchOrders.settlementBatchId,
            })
            .from(settlementBatchOrders)
            .where(inArray(settlementBatchOrders.settlementBatchId, batchIds))
            .orderBy(asc(settlementBatchOrders.settlementBatchId)),
          db
            .select({
              settlementBatchId: settlementBatchOrders.settlementBatchId,
              storeId: fulfillmentOrders.storeId,
            })
            .from(settlementBatchOrders)
            .innerJoin(
              fulfillmentOrders,
              eq(fulfillmentOrders.id, settlementBatchOrders.orderId),
            )
            .where(inArray(settlementBatchOrders.settlementBatchId, batchIds)),
        ]);

  const orderCountByBatch = new Map<string, number>();
  for (const row of counts) {
    orderCountByBatch.set(
      row.settlementBatchId,
      (orderCountByBatch.get(row.settlementBatchId) ?? 0) + 1,
    );
  }

  const storeIdsByBatch = new Map<string, Set<string>>();
  for (const row of storeRows) {
    const current = storeIdsByBatch.get(row.settlementBatchId) ?? new Set<string>();
    current.add(row.storeId);
    storeIdsByBatch.set(row.settlementBatchId, current);
  }

  return rows.map((row) => ({
    ...row,
    orderCount: orderCountByBatch.get(row.id) ?? 0,
    statusLabel: getAdminSettlementBatchStatusLabel(row.status),
    storeIds: [...(storeIdsByBatch.get(row.id) ?? new Set<string>())],
  }));
}

export async function getAdminSettlementBatchDetail(settlementBatchId: string) {
  await requireAdmin();

  const [batch] = await db
    .select({
      batchNumber: settlementBatches.batchNumber,
      customerCode: customers.code,
      customerId: customers.id,
      customerName: customers.name,
      id: settlementBatches.id,
      offlineAmountFen: settlementBatches.offlineAmountFen,
      paidAt: settlementBatches.paidAt,
      paymentReportedAt: settlementBatches.paymentReportedAt,
      status: settlementBatches.status,
      totalAmountFen: settlementBatches.totalAmountFen,
      walletAmountFen: settlementBatches.walletAmountFen,
    })
    .from(settlementBatches)
    .innerJoin(customers, eq(customers.id, settlementBatches.customerId))
    .where(eq(settlementBatches.id, settlementBatchId))
    .limit(1);
  if (!batch) return null;

  const [claim, walletHold, orders, audits] = await Promise.all([
    db
      .select({
        amountFen: settlementPaymentClaims.amountFen,
        createdAt: settlementPaymentClaims.createdAt,
        note: settlementPaymentClaims.note,
        rejectionReason: settlementPaymentClaims.rejectionReason,
        reviewedAt: settlementPaymentClaims.reviewedAt,
        status: settlementPaymentClaims.status,
        withdrawalReason: settlementPaymentClaims.withdrawalReason,
      })
      .from(settlementPaymentClaims)
      .where(eq(settlementPaymentClaims.settlementBatchId, settlementBatchId))
      .orderBy(desc(settlementPaymentClaims.createdAt))
      .limit(1),
    db
      .select({
        amountFen: walletHolds.amountFen,
        status: walletHolds.status,
      })
      .from(walletHolds)
      .where(eq(walletHolds.settlementBatchId, settlementBatchId))
      .orderBy(desc(walletHolds.createdAt))
      .limit(1),
    db
      .select({
        offlineAmountFen: settlementBatchOrders.offlineAmountFen,
        orderId: settlementBatchOrders.orderId,
        orderNumber: fulfillmentOrders.orderNumber,
        status: fulfillmentOrders.status,
        storeName: stores.name,
        totalAmountFen: settlementBatchOrders.totalAmountFen,
        walletAmountFen: settlementBatchOrders.walletAmountFen,
      })
      .from(settlementBatchOrders)
      .innerJoin(
        fulfillmentOrders,
        eq(fulfillmentOrders.id, settlementBatchOrders.orderId),
      )
      .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
      .where(eq(settlementBatchOrders.settlementBatchId, settlementBatchId))
      .orderBy(
        asc(settlementBatchOrders.totalAmountFen),
        asc(settlementBatchOrders.orderId),
      ),
    db
      .select({
        action: auditLogs.action,
        actorId: auditLogs.actorId,
        actorType: auditLogs.actorType,
        createdAt: auditLogs.createdAt,
        id: auditLogs.id,
        reason: auditLogs.reason,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "SETTLEMENT_BATCH"),
          eq(auditLogs.entityId, settlementBatchId),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(20),
  ]);

  const adminActorIds = audits
    .flatMap((entry) =>
      entry.actorType === "ADMIN" && entry.actorId ? [entry.actorId] : [],
    )
    .filter((value, index, all) => all.indexOf(value) === index);
  const adminActors =
    adminActorIds.length === 0
      ? []
      : await db
          .select({
            id: adminUsers.id,
            loginIdentifier: adminUsers.loginIdentifier,
          })
          .from(adminUsers)
          .where(inArray(adminUsers.id, adminActorIds));
  const adminActorMap = new Map(
    adminActors.map((entry) => [entry.id, entry.loginIdentifier]),
  );

  return {
    auditEntries: audits.map((entry) => ({
      actionLabel: getAdminSettlementAuditActionLabel(entry.action),
      actorLabel:
        entry.actorType === "ADMIN"
          ? adminActorMap.get(entry.actorId ?? "") ?? "管理员"
          : entry.actorType === "SYSTEM"
            ? "系统"
            : "客户",
      createdAt: entry.createdAt,
      id: entry.id,
      reason: entry.reason,
    })),
    batch: {
      batchNumber: batch.batchNumber,
      claimStatusLabel: getAdminSettlementClaimStatusLabel(claim[0]?.status ?? null),
      customerLabel: `${batch.customerCode} · ${batch.customerName}`,
      id: batch.id,
      offlineAmountFen: batch.offlineAmountFen,
      paidAt: batch.paidAt,
      paymentReportedAt: batch.paymentReportedAt,
      status: batch.status,
      statusLabel: getAdminSettlementBatchStatusLabel(batch.status),
      totalAmountFen: batch.totalAmountFen,
      walletAmountFen: batch.walletAmountFen,
      walletHoldLabel: walletHold[0]
        ? `${getAdminWalletHoldStatusLabel(walletHold[0].status)}`
        : "未冻结",
    },
    claim: claim[0]
      ? {
          amountFen: claim[0].amountFen,
          createdAt: claim[0].createdAt,
          note: claim[0].note,
          rejectionReason: claim[0].rejectionReason,
          reviewedAt: claim[0].reviewedAt,
          statusLabel: getAdminSettlementClaimStatusLabel(claim[0].status),
          withdrawalReason: claim[0].withdrawalReason,
        }
      : null,
    orders: orders.map((order) => ({
      offlineAmountFen: order.offlineAmountFen,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      statusLabel: getAdminSettlementOrderStatusLabel(order.status),
      storeName: order.storeName,
      totalAmountFen: order.totalAmountFen,
      walletAmountFen: order.walletAmountFen,
    })),
  };
}
