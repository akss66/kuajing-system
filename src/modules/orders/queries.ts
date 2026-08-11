import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { fulfillmentOrders, orderLines, stores } from "@/db/schema";

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

  const lines = await db
    .select({
      externalSku: orderLines.externalSku,
      externalSubOrderNo: orderLines.externalSubOrderNo,
      id: orderLines.id,
      lineAmountFen: orderLines.lineAmountFen,
      quantity: orderLines.quantity,
      skuCode: orderLines.skuCodeSnapshot,
      skuName: orderLines.skuNameSnapshot,
      unitPriceFen: orderLines.unitPriceFen,
    })
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(orderLines.createdAt);

  return { ...order, lines };
}
