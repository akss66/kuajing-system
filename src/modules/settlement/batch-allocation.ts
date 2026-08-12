import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  fulfillmentOrders,
  settlementBatchOrders,
  settlementBatches,
  walletHolds,
} from "@/db/schema";

export async function getSettlementBatchAllocation(
  customerId: string,
  settlementBatchId: string,
) {
  const [batch] = await db
    .select({
      batchNumber: settlementBatches.batchNumber,
      customerId: settlementBatches.customerId,
      id: settlementBatches.id,
      offlineAmountFen: settlementBatches.offlineAmountFen,
      paidAt: settlementBatches.paidAt,
      paymentDueAt: settlementBatches.paymentDueAt,
      status: settlementBatches.status,
      totalAmountFen: settlementBatches.totalAmountFen,
      walletAmountFen: settlementBatches.walletAmountFen,
    })
    .from(settlementBatches)
    .where(
      and(
        eq(settlementBatches.id, settlementBatchId),
        eq(settlementBatches.customerId, customerId),
      ),
    )
    .limit(1);
  if (!batch) return null;

  const orders = await db
    .select({
      offlineAmountFen: settlementBatchOrders.offlineAmountFen,
      orderId: settlementBatchOrders.orderId,
      orderNumber: fulfillmentOrders.orderNumber,
      status: fulfillmentOrders.status,
      totalAmountFen: settlementBatchOrders.totalAmountFen,
      walletAmountFen: settlementBatchOrders.walletAmountFen,
    })
    .from(settlementBatchOrders)
    .innerJoin(
      fulfillmentOrders,
      eq(fulfillmentOrders.id, settlementBatchOrders.orderId),
    )
    .where(
      and(
        eq(settlementBatchOrders.settlementBatchId, settlementBatchId),
        eq(settlementBatchOrders.customerId, customerId),
      ),
    )
    .orderBy(
      asc(settlementBatchOrders.totalAmountFen),
      asc(settlementBatchOrders.orderId),
    );
  const [walletHold] = await db
    .select({
      amountFen: walletHolds.amountFen,
      consumedAt: walletHolds.consumedAt,
      id: walletHolds.id,
      releaseReason: walletHolds.releaseReason,
      releasedAt: walletHolds.releasedAt,
      status: walletHolds.status,
    })
    .from(walletHolds)
    .where(
      and(
        eq(walletHolds.settlementBatchId, settlementBatchId),
        eq(walletHolds.customerId, customerId),
      ),
    )
    .orderBy(asc(walletHolds.createdAt))
    .limit(1);

  return { ...batch, orders, walletHold: walletHold ?? null };
}
