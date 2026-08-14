import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customers,
  fulfillmentOrders,
  orderLines,
  orderShipments,
  paymentClaims,
  replacementRequests,
  shipmentFulfillments,
  stores,
  walletTransactions,
} from "@/db/schema";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const adminOrderStatuses = [
  "PENDING_PAYMENT",
  "PAID_PENDING_FULFILLMENT",
  "FULFILLING",
  "SHIPPED",
  "FULFILLMENT_EXCEPTION",
  "CANCELLED",
  "EXPIRED",
] as const;

export type AdminOrderStatus = (typeof adminOrderStatuses)[number];

export type AdminOrderFilters = {
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  orderNumber?: string;
  status?: AdminOrderStatus;
  storeId?: string;
};

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function listCustomerOrders(
  customerId: string,
  status?: "PENDING_PAYMENT",
) {
  return db
    .select({
      createdAt: fulfillmentOrders.createdAt,
      id: fulfillmentOrders.id,
      lockExpiresAt: fulfillmentOrders.lockExpiresAt,
      orderNumber: fulfillmentOrders.orderNumber,
      paymentMode: fulfillmentOrders.paymentMode,
      status: fulfillmentOrders.status,
      storeName: stores.name,
      totalAmountFen: fulfillmentOrders.totalAmountFen,
      totalPackageCount: fulfillmentOrders.totalPackageCount,
      totalQuantity: fulfillmentOrders.totalQuantity,
    })
    .from(fulfillmentOrders)
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .where(
      status
        ? and(
            eq(fulfillmentOrders.customerId, customerId),
            eq(fulfillmentOrders.status, status),
          )
        : eq(fulfillmentOrders.customerId, customerId),
    )
    .orderBy(desc(fulfillmentOrders.createdAt));
}

export async function getCustomerOrderDetail(customerId: string, orderId: string) {
  const [order] = await db
    .select({
      cancelReason: fulfillmentOrders.cancelReason,
      createdAt: fulfillmentOrders.createdAt,
      id: fulfillmentOrders.id,
      lockExpiresAt: fulfillmentOrders.lockExpiresAt,
      orderNumber: fulfillmentOrders.orderNumber,
      paidAt: fulfillmentOrders.paidAt,
      paymentMode: fulfillmentOrders.paymentMode,
      status: fulfillmentOrders.status,
      storeName: stores.name,
      totalAmountFen: fulfillmentOrders.totalAmountFen,
      totalPackageCount: fulfillmentOrders.totalPackageCount,
      totalQuantity: fulfillmentOrders.totalQuantity,
    })
    .from(fulfillmentOrders)
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .where(
      and(
        eq(fulfillmentOrders.id, orderId),
        eq(fulfillmentOrders.customerId, customerId),
      ),
    )
    .limit(1);
  if (!order) return null;

  const [lines, paymentClaimRows, shipments, refundRows] = await Promise.all([
    db
      .select({
        externalSku: orderLines.externalSku,
        externalSubOrderNo: orderLines.externalSubOrderNo,
        id: orderLines.id,
        lineAmountFen: orderLines.lineAmountFen,
        quantity: orderLines.quantity,
        skuCode: orderLines.skuCodeSnapshot,
        skuName: orderLines.skuNameSnapshot,
        unitPriceFen: orderLines.unitPriceFen,
        unitPriceMilliYuan: orderLines.unitPriceMilliYuan,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .orderBy(orderLines.createdAt),
    db
      .select({
        amountFen: paymentClaims.amountFen,
        createdAt: paymentClaims.createdAt,
        id: paymentClaims.id,
        note: paymentClaims.note,
        rejectionReason: paymentClaims.rejectionReason,
        reviewedAt: paymentClaims.reviewedAt,
        status: paymentClaims.status,
      })
      .from(paymentClaims)
      .where(eq(paymentClaims.orderId, order.id))
      .orderBy(desc(paymentClaims.createdAt))
      .limit(1),
    db
      .select({
        fulfillmentStatus: shipmentFulfillments.status,
        id: orderShipments.id,
        kind: orderShipments.kind,
        replacementStatus: replacementRequests.status,
      })
      .from(orderShipments)
      .leftJoin(shipmentFulfillments, eq(shipmentFulfillments.shipmentId, orderShipments.id))
      .leftJoin(replacementRequests, eq(replacementRequests.replacementShipmentId, orderShipments.id))
      .where(eq(orderShipments.orderId, order.id))
      .orderBy(orderShipments.createdAt),
    db
      .select({ refundedAt: walletTransactions.createdAt })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.customerId, customerId),
          eq(walletTransactions.orderId, order.id),
          eq(walletTransactions.transactionType, "ORDER_REFUND"),
        ),
      )
      .limit(1),
  ]);

  return {
    ...order,
    latestPaymentClaim: paymentClaimRows[0] ?? null,
    lines,
    refundedAt: refundRows[0]?.refundedAt ?? null,
    shipments,
  };
}

export type CustomerOrderDetail = NonNullable<
  Awaited<ReturnType<typeof getCustomerOrderDetail>>
>;

export async function listPendingPaymentClaims() {
  return db
    .select({
      amountFen: paymentClaims.amountFen,
      claimId: paymentClaims.id,
      createdAt: paymentClaims.createdAt,
      customerCode: customers.code,
      customerName: customers.name,
      note: paymentClaims.note,
      orderId: fulfillmentOrders.id,
      orderNumber: fulfillmentOrders.orderNumber,
      storeName: stores.name,
    })
    .from(paymentClaims)
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, paymentClaims.orderId))
    .innerJoin(customers, eq(customers.id, paymentClaims.customerId))
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .where(eq(paymentClaims.status, "PENDING"))
    .orderBy(paymentClaims.createdAt);
}

export async function listAdminOrders(filters: AdminOrderFilters = {}) {
  const conditions: SQL[] = [];
  if (filters.status && adminOrderStatuses.includes(filters.status)) {
    conditions.push(eq(fulfillmentOrders.status, filters.status));
  }
  if (filters.customerId) conditions.push(eq(fulfillmentOrders.customerId, filters.customerId));
  if (filters.storeId) conditions.push(eq(fulfillmentOrders.storeId, filters.storeId));
  if (filters.orderNumber?.trim()) {
    conditions.push(ilike(fulfillmentOrders.orderNumber, `%${filters.orderNumber.trim()}%`));
  }
  if (filters.dateFrom && isIsoDate(filters.dateFrom)) {
    conditions.push(
      sql`(${fulfillmentOrders.createdAt} at time zone ${BUSINESS_TIME_ZONE})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo && isIsoDate(filters.dateTo)) {
    conditions.push(
      sql`(${fulfillmentOrders.createdAt} at time zone ${BUSINESS_TIME_ZONE})::date <= ${filters.dateTo}::date`,
    );
  }

  return db
    .select({
      cancelReason: fulfillmentOrders.cancelReason,
      createdAt: fulfillmentOrders.createdAt,
      customerCode: customers.code,
      customerName: customers.name,
      id: fulfillmentOrders.id,
      lockExpiresAt: fulfillmentOrders.lockExpiresAt,
      orderNumber: fulfillmentOrders.orderNumber,
      paymentMode: fulfillmentOrders.paymentMode,
      status: fulfillmentOrders.status,
      storeName: stores.name,
      totalAmountFen: fulfillmentOrders.totalAmountFen,
      totalPackageCount: fulfillmentOrders.totalPackageCount,
      totalQuantity: fulfillmentOrders.totalQuantity,
    })
    .from(fulfillmentOrders)
    .innerJoin(customers, eq(customers.id, fulfillmentOrders.customerId))
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      sql`case
        when ${fulfillmentOrders.status} = 'FULFILLMENT_EXCEPTION' then 0
        when ${fulfillmentOrders.status} = 'PENDING_PAYMENT'
          and ${fulfillmentOrders.lockExpiresAt} <= now() then 1
        else 2
      end`,
      desc(fulfillmentOrders.createdAt),
    )
    .limit(500);
}

export async function listAdminOrderFilterOptions() {
  const [customerRows, storeRows] = await Promise.all([
    db
      .select({ code: customers.code, id: customers.id, name: customers.name })
      .from(customers)
      .orderBy(customers.code),
    db
      .select({ customerId: stores.customerId, id: stores.id, name: stores.name })
      .from(stores)
      .orderBy(stores.name),
  ]);
  return { customers: customerRows, stores: storeRows };
}

export async function getAdminOrderDetail(orderId: string) {
  const [order] = await db
    .select({
      cancelReason: fulfillmentOrders.cancelReason,
      createdAt: fulfillmentOrders.createdAt,
      customerCode: customers.code,
      customerName: customers.name,
      id: fulfillmentOrders.id,
      orderNumber: fulfillmentOrders.orderNumber,
      paidAt: fulfillmentOrders.paidAt,
      paymentMode: fulfillmentOrders.paymentMode,
      status: fulfillmentOrders.status,
      storeName: stores.name,
      totalAmountFen: fulfillmentOrders.totalAmountFen,
      totalPackageCount: fulfillmentOrders.totalPackageCount,
      totalQuantity: fulfillmentOrders.totalQuantity,
    })
    .from(fulfillmentOrders)
    .innerJoin(customers, eq(customers.id, fulfillmentOrders.customerId))
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .where(eq(fulfillmentOrders.id, orderId))
    .limit(1);
  if (!order) return null;

  const [shipments, lines, refundRows] = await Promise.all([
    db
      .select({
        attemptCount: shipmentFulfillments.attemptCount,
        cancelledAt: shipmentFulfillments.cancelledAt,
        erpNo: shipmentFulfillments.erpNo,
        externalOrderNo: orderShipments.externalOrderNo,
        fulfillmentId: shipmentFulfillments.id,
        fulfillmentStatus: shipmentFulfillments.status,
        id: orderShipments.id,
        jifengStatus: shipmentFulfillments.jifengStatus,
        kind: orderShipments.kind,
        lastErrorCode: shipmentFulfillments.lastErrorCode,
        lastErrorMessage: shipmentFulfillments.lastErrorMessage,
        logisticsCurrency: orderShipments.logisticsCurrency,
        logisticsFeeMinor: orderShipments.logisticsFeeMinor,
        nextRetryAt: shipmentFulfillments.nextRetryAt,
        replacementReason: replacementRequests.reason,
        replacementStatus: replacementRequests.status,
        shippedAt: orderShipments.shippedAt,
        trackingNumber: orderShipments.trackingNumber,
      })
      .from(orderShipments)
      .leftJoin(
        shipmentFulfillments,
        eq(shipmentFulfillments.shipmentId, orderShipments.id),
      )
      .leftJoin(
        replacementRequests,
        eq(replacementRequests.replacementShipmentId, orderShipments.id),
      )
      .where(eq(orderShipments.orderId, orderId))
      .orderBy(orderShipments.createdAt),
    db
      .select({
        id: orderLines.id,
        lineAmountFen: orderLines.lineAmountFen,
        quantity: orderLines.quantity,
        shipmentId: orderLines.shipmentId,
        skuCode: orderLines.skuCodeSnapshot,
        skuId: orderLines.skuId,
        skuName: orderLines.skuNameSnapshot,
        unitPriceFen: orderLines.unitPriceFen,
        unitPriceMilliYuan: orderLines.unitPriceMilliYuan,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId))
      .orderBy(orderLines.createdAt),
    db
      .select({ refundedAt: walletTransactions.createdAt })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.orderId, orderId),
          eq(walletTransactions.transactionType, "ORDER_REFUND"),
        ),
      )
      .limit(1),
  ]);

  return {
    ...order,
    refundedAt: refundRows[0]?.refundedAt ?? null,
    shipments: shipments.map((shipment) => ({
      ...shipment,
      lines: lines.filter((line) => line.shipmentId === shipment.id),
    })),
  };
}
