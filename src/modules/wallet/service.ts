import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  settlementBatchOrders,
  walletAccounts,
  walletHolds,
  walletTransactions,
} from "@/db/schema";

export class WalletValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletValidationError";
  }
}

export class WalletInsufficientFundsError extends Error {
  constructor() {
    super("钱包余额不足");
    this.name = "WalletInsufficientFundsError";
  }
}

async function ensureAndLockWallet(
  tx: DbTransaction,
  customerId: string,
): Promise<{ balanceFen: number; version: number }> {
  await tx
    .insert(walletAccounts)
    .values({ customerId })
    .onConflictDoNothing({ target: walletAccounts.customerId });
  const rows = await tx.execute<{ balanceFen: number; version: number }>(sql`
    select balance_fen as "balanceFen", version
    from wallet_accounts
    where customer_id = ${customerId}
    for update
  `);
  const wallet = rows[0];
  if (!wallet) throw new WalletValidationError("客户钱包不存在");
  return wallet;
}

export type LockedWalletFunding = {
  availableFen: number;
  balanceFen: number;
  version: number;
};

export type WalletHold = typeof walletHolds.$inferSelect;

type WalletHoldIdentity = {
  customerId: string;
  settlementBatchId: string;
};

async function lockWalletHold(
  tx: DbTransaction,
  input: WalletHoldIdentity,
): Promise<WalletHold> {
  const [hold] = await tx
    .select()
    .from(walletHolds)
    .where(
      and(
        eq(walletHolds.customerId, input.customerId),
        eq(walletHolds.settlementBatchId, input.settlementBatchId),
      ),
    )
    .orderBy(asc(walletHolds.createdAt))
    .for("update")
    .limit(1);
  if (!hold) throw new WalletValidationError("找不到该结算批次的钱包冻结");
  return hold;
}

export async function lockWalletFunding(
  tx: DbTransaction,
  customerId: string,
): Promise<LockedWalletFunding> {
  const wallet = await ensureAndLockWallet(tx, customerId);
  const heldRows = await tx.execute<{ heldFen: number }>(sql`
    select coalesce(sum(amount_fen), 0)::integer as "heldFen"
    from wallet_holds
    where customer_id = ${customerId}
      and status = 'ACTIVE'
  `);
  const heldFen = heldRows[0]?.heldFen ?? 0;
  return {
    availableFen: Math.max(0, wallet.balanceFen - heldFen),
    balanceFen: wallet.balanceFen,
    version: wallet.version,
  };
}

export async function createWalletHold(
  tx: DbTransaction,
  input: WalletHoldIdentity & { amountFen: number },
): Promise<WalletHold> {
  assertFen(input.amountFen, false);
  if (input.amountFen < 0) {
    throw new WalletValidationError("钱包冻结金额必须是正的人民币分整数");
  }
  const wallet = await lockWalletFunding(tx, input.customerId);
  const [existing] = await tx
    .select()
    .from(walletHolds)
    .where(
      and(
        eq(walletHolds.customerId, input.customerId),
        eq(walletHolds.settlementBatchId, input.settlementBatchId),
      ),
    )
    .orderBy(asc(walletHolds.createdAt))
    .for("update")
    .limit(1);
  if (existing) {
    if (existing.amountFen !== input.amountFen) {
      throw new WalletValidationError("该结算批次的钱包冻结金额不一致");
    }
    return existing;
  }
  if (input.amountFen > wallet.availableFen) {
    throw new WalletInsufficientFundsError();
  }
  const [hold] = await tx.insert(walletHolds).values(input).returning();
  return hold;
}

export async function consumeWalletHold(
  tx: DbTransaction,
  input: WalletHoldIdentity & {
    actorType?: "ADMIN" | "SYSTEM";
    actorUserId: string;
    now?: Date;
  },
): Promise<void> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) throw new WalletValidationError("钱包冻结核销人不能为空");
  const now = input.now ?? new Date();
  const wallet = await lockWalletFunding(tx, input.customerId);
  const hold = await lockWalletHold(tx, input);
  if (hold.status === "CONSUMED") return;
  if (hold.status === "RELEASED") {
    throw new WalletValidationError("已释放的钱包冻结不能核销");
  }
  if (wallet.balanceFen < hold.amountFen) {
    throw new WalletInsufficientFundsError();
  }

  const allocations = await tx
    .select({
      orderId: settlementBatchOrders.orderId,
      walletFen: settlementBatchOrders.walletAmountFen,
    })
    .from(settlementBatchOrders)
    .where(
      and(
        eq(settlementBatchOrders.customerId, input.customerId),
        eq(settlementBatchOrders.settlementBatchId, input.settlementBatchId),
      ),
    )
    .orderBy(asc(settlementBatchOrders.orderId));
  const debits = allocations.filter((allocation) => allocation.walletFen > 0);
  const allocatedFen = debits.reduce(
    (total, allocation) => total + allocation.walletFen,
    0,
  );
  if (!Number.isSafeInteger(allocatedFen) || allocatedFen !== hold.amountFen) {
    throw new WalletValidationError("结算批次分摊与钱包冻结金额不一致");
  }

  let runningBalanceFen = wallet.balanceFen;
  const transactions = debits.map((allocation) => {
    const beforeBalanceFen = runningBalanceFen;
    runningBalanceFen -= allocation.walletFen;
    return {
      actorId: actorUserId,
      actorType: input.actorType ?? ("ADMIN" as const),
      afterBalanceFen: runningBalanceFen,
      beforeBalanceFen,
      customerId: input.customerId,
      deltaFen: -allocation.walletFen,
      orderId: allocation.orderId,
      reason: "线下付款确认后核销批次钱包冻结",
      transactionType: "ORDER_DEBIT" as const,
    };
  });
  await tx
    .update(walletAccounts)
    .set({
      balanceFen: runningBalanceFen,
      updatedAt: now,
      version: wallet.version + 1,
    })
    .where(eq(walletAccounts.customerId, input.customerId));
  await tx.insert(walletTransactions).values(transactions);
  await tx
    .update(walletHolds)
    .set({ consumedAt: now, status: "CONSUMED", updatedAt: now })
    .where(eq(walletHolds.id, hold.id));
  await tx.insert(auditLogs).values({
    action: "WALLET_SETTLEMENT_HOLD_CONSUMED",
    actorId: actorUserId,
    actorType: input.actorType ?? "ADMIN",
    afterJson: { balanceFen: runningBalanceFen, status: "CONSUMED" },
    beforeJson: { balanceFen: wallet.balanceFen, status: "ACTIVE" },
    entityId: input.settlementBatchId,
    entityType: "SETTLEMENT_BATCH",
    reason: "线下付款确认后核销钱包冻结",
  });
}

export async function releaseWalletHold(
  tx: DbTransaction,
  input: WalletHoldIdentity & {
    actorType?: "ADMIN" | "CUSTOMER" | "SYSTEM";
    actorUserId: string;
    now?: Date;
    reason: string;
  },
): Promise<void> {
  const actorUserId = input.actorUserId.trim();
  const reason = input.reason.trim();
  if (!actorUserId) throw new WalletValidationError("钱包冻结释放人不能为空");
  if (!reason) throw new WalletValidationError("释放钱包冻结必须填写原因");
  const now = input.now ?? new Date();
  await lockWalletFunding(tx, input.customerId);
  const hold = await lockWalletHold(tx, input);
  if (hold.status === "RELEASED") {
    if (hold.releaseReason !== reason) {
      throw new WalletValidationError("已释放的钱包冻结原因与重放请求不一致");
    }
    return;
  }
  if (hold.status === "CONSUMED") {
    throw new WalletValidationError("已核销的钱包冻结不能释放");
  }
  await tx
    .update(walletHolds)
    .set({
      releaseReason: reason,
      releasedAt: now,
      status: "RELEASED",
      updatedAt: now,
    })
    .where(eq(walletHolds.id, hold.id));
  await tx.insert(auditLogs).values({
    action: "WALLET_SETTLEMENT_HOLD_RELEASED",
    actorId: actorUserId,
    actorType: input.actorType ?? "ADMIN",
    afterJson: { reason, status: "RELEASED" },
    beforeJson: { status: "ACTIVE" },
    entityId: input.settlementBatchId,
    entityType: "SETTLEMENT_BATCH",
    reason,
  });
}

export async function applyBulkSettlementWallet(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    allocations: readonly { orderId: string; walletFen: number }[];
    customerId: string;
    settlementBatchId: string;
    snapshot: LockedWalletFunding;
    totalAmountFen: number;
    walletAmountFen: number;
    now: Date;
  },
) {
  assertFen(input.totalAmountFen, false);
  assertFen(input.walletAmountFen, true);
  if (
    input.totalAmountFen <= 0 ||
    input.walletAmountFen > input.totalAmountFen ||
    input.walletAmountFen > input.snapshot.availableFen
  ) {
    throw new WalletValidationError("批量结算钱包分配无效");
  }
  const allocatedFen = input.allocations.reduce(
    (total, allocation) => total + allocation.walletFen,
    0,
  );
  if (
    !Number.isSafeInteger(allocatedFen) ||
    allocatedFen !== input.walletAmountFen
  ) {
    throw new WalletValidationError("批量结算订单分配与钱包总额不一致");
  }
  if (input.walletAmountFen === 0) return "NONE" as const;

  if (input.walletAmountFen < input.totalAmountFen) {
    await createWalletHold(tx, {
      amountFen: input.walletAmountFen,
      customerId: input.customerId,
      settlementBatchId: input.settlementBatchId,
    });
    await tx.insert(auditLogs).values({
      action: "WALLET_SETTLEMENT_HELD",
      actorId: input.actorUserId,
      actorType: "SYSTEM",
      afterJson: { amountFen: input.walletAmountFen, status: "ACTIVE" },
      beforeJson: { availableFen: input.snapshot.availableFen },
      entityId: input.settlementBatchId,
      entityType: "SETTLEMENT_BATCH",
      reason: "为批量结算保留可用钱包余额",
    });
    return "MIXED" as const;
  }

  const debits = [...input.allocations]
    .filter((allocation) => allocation.walletFen > 0)
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
  let runningBalanceFen = input.snapshot.balanceFen;
  const transactions = debits.map((allocation) => {
    const beforeBalanceFen = runningBalanceFen;
    runningBalanceFen -= allocation.walletFen;
    return {
      actorId: input.actorUserId,
      actorType: "SYSTEM" as const,
      afterBalanceFen: runningBalanceFen,
      beforeBalanceFen,
      customerId: input.customerId,
      deltaFen: -allocation.walletFen,
      orderId: allocation.orderId,
      reason: "批量结算纯钱包支付自动扣款",
      transactionType: "ORDER_DEBIT" as const,
    };
  });
  if (runningBalanceFen !== input.snapshot.balanceFen - input.walletAmountFen) {
    throw new WalletValidationError("批量结算钱包流水链不平衡");
  }
  await tx
    .update(walletAccounts)
    .set({
      balanceFen: runningBalanceFen,
      updatedAt: input.now,
      version: input.snapshot.version + 1,
    })
    .where(eq(walletAccounts.customerId, input.customerId));
  await tx.insert(walletTransactions).values(transactions);
  await tx.insert(auditLogs).values({
    action: "WALLET_SETTLEMENT_DEBITED",
    actorId: input.actorUserId,
    actorType: "SYSTEM",
    afterJson: {
      balanceFen: runningBalanceFen,
      debitedFen: input.walletAmountFen,
      orderCount: transactions.length,
    },
    beforeJson: { balanceFen: input.snapshot.balanceFen },
    entityId: input.settlementBatchId,
    entityType: "SETTLEMENT_BATCH",
    reason: "批量结算纯钱包支付完成扣款",
  });
  return "PURE_WALLET" as const;
}

function assertFen(value: number, allowZero: boolean) {
  if (
    !Number.isSafeInteger(value) ||
    value < -2_147_483_648 ||
    value > 2_147_483_647 ||
    (allowZero ? value < 0 : value === 0)
  ) {
    throw new WalletValidationError("金额必须是有效的人民币分整数");
  }
}

export async function adjustWalletBalance(input: {
  actorUserId: string;
  customerId: string;
  deltaFen: number;
  reason: string;
}) {
  assertFen(input.deltaFen, false);
  const reason = input.reason.trim();
  if (!reason) throw new WalletValidationError("调整余额必须填写原因");

  await db
    .insert(walletAccounts)
    .values({ customerId: input.customerId })
    .onConflictDoNothing({ target: walletAccounts.customerId });

  return db.transaction(async (tx) => {
    const wallet = await lockWalletFunding(tx, input.customerId);
    const afterBalanceFen = wallet.balanceFen + input.deltaFen;
    if (
      afterBalanceFen < 0 ||
      (input.deltaFen < 0 && -input.deltaFen > wallet.availableFen)
    ) {
      throw new WalletInsufficientFundsError();
    }
    if (!Number.isSafeInteger(afterBalanceFen) || afterBalanceFen > 2_147_483_647) {
      throw new WalletValidationError("钱包余额超出系统范围");
    }

    await tx
      .update(walletAccounts)
      .set({
        balanceFen: afterBalanceFen,
        updatedAt: new Date(),
        version: wallet.version + 1,
      })
      .where(eq(walletAccounts.customerId, input.customerId));
    const [transaction] = await tx
      .insert(walletTransactions)
      .values({
        actorId: input.actorUserId,
        actorType: "ADMIN",
        afterBalanceFen,
        beforeBalanceFen: wallet.balanceFen,
        customerId: input.customerId,
        deltaFen: input.deltaFen,
        reason,
        transactionType: input.deltaFen > 0 ? "ADMIN_CREDIT" : "ADMIN_DEBIT",
      })
      .returning({ id: walletTransactions.id });
    await tx.insert(auditLogs).values({
      action: "WALLET_ADJUSTED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: { balanceFen: afterBalanceFen },
      beforeJson: { balanceFen: wallet.balanceFen },
      entityId: input.customerId,
      entityType: "CUSTOMER_WALLET",
      reason,
    });

    return {
      afterBalanceFen,
      beforeBalanceFen: wallet.balanceFen,
      transactionId: transaction.id,
    };
  });
}

export async function tryDebitWalletForOrder(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    amountFen: number;
    customerId: string;
    orderId: string;
  },
) {
  assertFen(input.amountFen, true);
  const wallet = await lockWalletFunding(tx, input.customerId);
  if (wallet.availableFen < input.amountFen) return false;
  if (input.amountFen === 0) return true;

  const afterBalanceFen = wallet.balanceFen - input.amountFen;
  await tx
    .update(walletAccounts)
    .set({
      balanceFen: afterBalanceFen,
      updatedAt: new Date(),
      version: wallet.version + 1,
    })
    .where(eq(walletAccounts.customerId, input.customerId));
  await tx.insert(walletTransactions).values({
    actorId: input.actorUserId,
    actorType: "SYSTEM",
    afterBalanceFen,
    beforeBalanceFen: wallet.balanceFen,
    customerId: input.customerId,
    deltaFen: -input.amountFen,
    orderId: input.orderId,
    reason: "提交拿货单时自动扣除客户余额",
    transactionType: "ORDER_DEBIT",
  });
  await tx.insert(auditLogs).values({
    action: "WALLET_ORDER_DEBITED",
    actorId: input.actorUserId,
    actorType: "SYSTEM",
    afterJson: { balanceFen: afterBalanceFen, orderId: input.orderId },
    beforeJson: { balanceFen: wallet.balanceFen },
    entityId: input.customerId,
    entityType: "CUSTOMER_WALLET",
    reason: "余额充足，拿货单自动扣款",
  });

  return true;
}

export async function refundWalletForOrder(
  tx: DbTransaction,
  input: {
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
    actorUserId: string;
    amountFen: number;
    customerId: string;
    orderId: string;
    reason: string;
  },
) {
  if (!Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) {
    throw new WalletValidationError("退款金额必须是正的人民币分整数");
  }
  const reason = input.reason.trim();
  if (!reason) throw new WalletValidationError("退款必须填写原因");

  const [existingRefund] = await tx
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.orderId, input.orderId),
        eq(walletTransactions.transactionType, "ORDER_REFUND"),
        isNull(walletTransactions.shipmentId),
      ),
    )
    .limit(1);
  if (existingRefund) return false;

  const [debit] = await tx
    .select({ deltaFen: walletTransactions.deltaFen })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.orderId, input.orderId),
        eq(walletTransactions.transactionType, "ORDER_DEBIT"),
      ),
    )
    .limit(1);
  if (!debit || debit.deltaFen !== -input.amountFen) {
    throw new WalletValidationError("找不到与订单金额一致的原始钱包扣款");
  }

  const wallet = await ensureAndLockWallet(tx, input.customerId);
  const afterBalanceFen = wallet.balanceFen + input.amountFen;
  if (!Number.isSafeInteger(afterBalanceFen) || afterBalanceFen > 2_147_483_647) {
    throw new WalletValidationError("钱包余额超出系统范围");
  }
  await tx
    .update(walletAccounts)
    .set({
      balanceFen: afterBalanceFen,
      updatedAt: new Date(),
      version: wallet.version + 1,
    })
    .where(eq(walletAccounts.customerId, input.customerId));
  await tx.insert(walletTransactions).values({
    actorId: input.actorUserId,
    actorType: input.actorType,
    afterBalanceFen,
    beforeBalanceFen: wallet.balanceFen,
    customerId: input.customerId,
    deltaFen: input.amountFen,
    orderId: input.orderId,
    reason,
    transactionType: "ORDER_REFUND",
  });
  await tx.insert(auditLogs).values({
    action: "WALLET_ORDER_REFUNDED",
    actorId: input.actorUserId,
    actorType: input.actorType,
    afterJson: { balanceFen: afterBalanceFen, orderId: input.orderId },
    beforeJson: { balanceFen: wallet.balanceFen },
    entityId: input.customerId,
    entityType: "CUSTOMER_WALLET",
    reason,
  });

  return true;
}

export async function refundWalletForShipment(
  tx: DbTransaction,
  input: {
    actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
    actorUserId: string | null;
    amountFen: number;
    customerId: string;
    orderId: string;
    reason: string;
    shipmentId: string;
  },
) {
  if (!Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) {
    throw new WalletValidationError("退款金额必须是正的人民币分整数");
  }
  const reason = input.reason.trim();
  if (!reason) throw new WalletValidationError("退款必须填写原因");

  await tx.execute(sql`
    select id
    from fulfillment_orders
    where id = ${input.orderId}
      and customer_id = ${input.customerId}
    for update
  `);
  const [existingRefund] = await tx
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.shipmentId, input.shipmentId),
        eq(walletTransactions.transactionType, "ORDER_REFUND"),
      ),
    )
    .limit(1);
  if (existingRefund) return false;

  const [debit] = await tx
    .select({ deltaFen: walletTransactions.deltaFen })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.orderId, input.orderId),
        eq(walletTransactions.transactionType, "ORDER_DEBIT"),
      ),
    )
    .limit(1);
  if (!debit) throw new WalletValidationError("找不到订单原始钱包扣款");
  const refundedRows = await tx.execute<{ amountFen: number }>(sql`
    select coalesce(sum(delta_fen), 0)::int as "amountFen"
    from wallet_transactions
    where order_id = ${input.orderId}
      and transaction_type = 'ORDER_REFUND'
  `);
  const refundedFen = refundedRows[0]?.amountFen ?? 0;
  if (refundedFen + input.amountFen > -debit.deltaFen) {
    throw new WalletValidationError("累计钱包退款不能超过订单原始钱包扣款");
  }

  const wallet = await ensureAndLockWallet(tx, input.customerId);
  const afterBalanceFen = wallet.balanceFen + input.amountFen;
  if (!Number.isSafeInteger(afterBalanceFen) || afterBalanceFen > 2_147_483_647) {
    throw new WalletValidationError("钱包余额超出系统范围");
  }
  const now = new Date();
  await tx
    .update(walletAccounts)
    .set({
      balanceFen: afterBalanceFen,
      updatedAt: now,
      version: wallet.version + 1,
    })
    .where(eq(walletAccounts.customerId, input.customerId));
  await tx.insert(walletTransactions).values({
    actorId: input.actorUserId,
    actorType: input.actorType,
    afterBalanceFen,
    beforeBalanceFen: wallet.balanceFen,
    customerId: input.customerId,
    deltaFen: input.amountFen,
    orderId: input.orderId,
    reason,
    shipmentId: input.shipmentId,
    transactionType: "ORDER_REFUND",
  });
  await tx.insert(auditLogs).values({
    action: "WALLET_SHIPMENT_REFUNDED",
    actorId: input.actorUserId,
    actorType: input.actorType,
    afterJson: {
      amountFen: input.amountFen,
      balanceFen: afterBalanceFen,
      orderId: input.orderId,
      shipmentId: input.shipmentId,
    },
    beforeJson: { balanceFen: wallet.balanceFen },
    entityId: input.customerId,
    entityType: "CUSTOMER_WALLET",
    reason,
  });
  return true;
}
