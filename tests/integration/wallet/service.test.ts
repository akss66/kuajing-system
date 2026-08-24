import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  customers,
  settlementBatches,
  walletAccounts,
  walletHolds,
  walletTransactions,
} from "@/db/schema";
import {
  WalletInsufficientFundsError,
  adjustWalletBalance,
} from "@/modules/wallet/service";

describe("wallet administration", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        wallet_transactions,
        wallet_holds,
        wallet_accounts,
        settlement_batches,
        customers
      restart identity cascade
    `));
  });

  test("records immutable before, delta and after balances", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: `W-${crypto.randomUUID()}`, name: "钱包客户" })
      .returning();

    await adjustWalletBalance({
      actorUserId: "admin-wallet",
      customerId: customer.id,
      deltaFen: 1000,
      reason: "微信收款充值",
    });
    await adjustWalletBalance({
      actorUserId: "admin-wallet",
      customerId: customer.id,
      deltaFen: -300,
      reason: "人工冲正",
    });

    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(700);
    const transactions = await db
      .select()
      .from(walletTransactions)
      .orderBy(walletTransactions.createdAt);
    expect(
      transactions.map((row) => [
        row.transactionType,
        row.beforeBalanceFen,
        row.deltaFen,
        row.afterBalanceFen,
      ]),
    ).toEqual([
      ["ADMIN_CREDIT", 0, 1000, 1000],
      ["ADMIN_DEBIT", 1000, -300, 700],
    ]);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, "WALLET_ADJUSTED")),
    ).toHaveLength(2);
  });

  test("applies a repeated administrative adjustment request only once", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: `W-${crypto.randomUUID()}`, name: "幂等余额客户" })
      .returning();
    const idempotencyKey = crypto.randomUUID();
    const input = {
      actorUserId: "admin-wallet",
      customerId: customer.id,
      deltaFen: 2_000,
      idempotencyKey,
      reason: "同一请求重复提交",
    };

    const first = await adjustWalletBalance(input);
    const repeated = await adjustWalletBalance(input);

    expect(repeated).toEqual(first);
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(2_000);
    expect(await db.select().from(walletTransactions)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "WALLET_ADJUSTED")),
    ).toHaveLength(1);
  });

  test("never allows an administrative adjustment to make balance negative", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: `W-${crypto.randomUUID()}`, name: "余额保护客户" })
      .returning();

    await expect(
      adjustWalletBalance({
        actorUserId: "admin-wallet",
        customerId: customer.id,
        deltaFen: -1,
        reason: "不允许的扣减",
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientFundsError);

    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(0);
    expect(await db.select().from(walletTransactions)).toEqual([]);
  });

  test("never allows an administrative debit to consume ACTIVE held funds", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ code: `W-${crypto.randomUUID()}`, name: "Held balance customer" })
      .returning();
    await adjustWalletBalance({
      actorUserId: "admin-wallet",
      customerId: customer.id,
      deltaFen: 100,
      reason: "held funds regression fixture",
    });
    const [settlement] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `ADMIN-HELD-${crypto.randomUUID()}`,
        customerId: customer.id,
        idempotencyKey: `admin-held-${crypto.randomUUID()}`,
        offlineAmountFen: 0,
        paymentDueAt: new Date(Date.now() + 60_000),
        totalAmountFen: 80,
        walletAmountFen: 80,
      })
      .returning();
    await db.insert(walletHolds).values({
      amountFen: 80,
      customerId: customer.id,
      settlementBatchId: settlement.id,
    });

    await expect(
      adjustWalletBalance({
        actorUserId: "admin-wallet",
        customerId: customer.id,
        deltaFen: -50,
        reason: "must preserve held balance",
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientFundsError);

    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.customerId, customer.id));
    expect(wallet.balanceFen).toBe(100);
    const transactions = await db.select().from(walletTransactions);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].transactionType).toBe("ADMIN_CREDIT");
  });
});
