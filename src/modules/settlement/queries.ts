import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  settlementBatches,
  settlementPaymentClaims,
} from "@/db/schema";

import { getSettlementBatchAllocation } from "./batch-allocation";

export async function getCustomerSettlementDetail(
  customerId: string,
  settlementBatchId: string,
) {
  const allocation = await getSettlementBatchAllocation(customerId, settlementBatchId);
  if (!allocation) return null;

  const [claim] = await db
    .select({
      amountFen: settlementPaymentClaims.amountFen,
      createdAt: settlementPaymentClaims.createdAt,
      id: settlementPaymentClaims.id,
      note: settlementPaymentClaims.note,
      rejectionReason: settlementPaymentClaims.rejectionReason,
      reviewedAt: settlementPaymentClaims.reviewedAt,
      status: settlementPaymentClaims.status,
      withdrawalReason: settlementPaymentClaims.withdrawalReason,
      withdrawnAt: settlementPaymentClaims.withdrawnAt,
    })
    .from(settlementPaymentClaims)
    .where(
      and(
        eq(settlementPaymentClaims.customerId, customerId),
        eq(settlementPaymentClaims.settlementBatchId, settlementBatchId),
      ),
    )
    .orderBy(desc(settlementPaymentClaims.createdAt))
    .limit(1);

  return { ...allocation, claim: claim ?? null };
}

export async function listCustomerSettlementBatches(customerId: string) {
  return db
    .select({
      batchNumber: settlementBatches.batchNumber,
      createdAt: settlementBatches.createdAt,
      id: settlementBatches.id,
      offlineAmountFen: settlementBatches.offlineAmountFen,
      paymentDueAt: settlementBatches.paymentDueAt,
      status: settlementBatches.status,
      totalAmountFen: settlementBatches.totalAmountFen,
      walletAmountFen: settlementBatches.walletAmountFen,
    })
    .from(settlementBatches)
    .where(eq(settlementBatches.customerId, customerId))
    .orderBy(desc(settlementBatches.createdAt))
    .limit(20);
}
