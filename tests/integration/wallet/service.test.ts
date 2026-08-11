import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import { auditLogs, customers, walletAccounts, walletTransactions } from "@/db/schema";
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
        wallet_accounts,
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
});
