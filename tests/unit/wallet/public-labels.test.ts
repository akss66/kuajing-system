import { describe, expect, test } from "vitest";

import {
  publicWalletHoldReleaseReason,
  publicWalletTransactionReason,
} from "@/modules/wallet/public-labels";

describe("customer-visible wallet labels", () => {
  test.each([
    ["ADMIN_CREDIT", "余额充值"],
    ["ADMIN_DEBIT", "余额调整扣减"],
    ["ORDER_DEBIT", "订单余额支付"],
    ["ORDER_REFUND", "订单退款"],
  ] as const)("maps %s without exposing an operator note", (type, expected) => {
    expect(publicWalletTransactionReason(type)).toBe(expected);
  });

  test.each([
    ["ACTIVE", null],
    ["CONSUMED", "已用于结算"],
    ["RELEASED", "冻结金额已释放"],
  ] as const)("maps %s without exposing an internal release reason", (status, expected) => {
    expect(publicWalletHoldReleaseReason(status)).toBe(expected);
  });
});
