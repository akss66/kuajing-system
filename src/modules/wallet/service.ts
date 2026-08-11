import { and, eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import { auditLogs, walletAccounts, walletTransactions } from "@/db/schema";

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
    const wallet = await ensureAndLockWallet(tx, input.customerId);
    const afterBalanceFen = wallet.balanceFen + input.deltaFen;
    if (afterBalanceFen < 0) throw new WalletInsufficientFundsError();
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
  const wallet = await ensureAndLockWallet(tx, input.customerId);
  if (wallet.balanceFen < input.amountFen) return false;
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
