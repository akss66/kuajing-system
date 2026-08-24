import { beforeEach, describe, expect, it, vi } from "vitest";

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
}));
const serviceMocks = vi.hoisted(() => ({ adjustWalletBalance: vi.fn() }));
const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/wallet/service", () => ({
  WalletInsufficientFundsError: class WalletInsufficientFundsError extends Error {},
  WalletValidationError: class WalletValidationError extends Error {},
  adjustWalletBalance: serviceMocks.adjustWalletBalance,
}));

import { adjustWalletAction } from "@/modules/wallet/actions";

describe("administrator wallet adjustments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardMocks.requireAdmin.mockResolvedValue({ kind: "ADMIN", userId: "admin-1" });
    serviceMocks.adjustWalletBalance.mockResolvedValue({
      afterBalanceFen: 1500,
      beforeBalanceFen: 500,
      transactionId: "transaction-1",
    });
  });

  it("allows an authenticated system administrator and preserves the audited idempotent command", async () => {
    const formData = new FormData();
    formData.set("amountYuan", "10.00");
    formData.set("customerId", "11111111-1111-4111-8111-111111111111");
    formData.set("operation", "CREDIT");
    formData.set("requestId", "22222222-2222-4222-8222-222222222222");
    formData.set("reason", "线下收款补录");

    await expect(adjustWalletAction({ status: "idle" }, formData)).resolves.toEqual({
      message: "余额已调整并写入资金流水。",
      status: "success",
    });

    expect(guardMocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(guardMocks.requireSuperAdmin).not.toHaveBeenCalled();
    expect(serviceMocks.adjustWalletBalance).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      customerId: "11111111-1111-4111-8111-111111111111",
      deltaFen: 1000,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      reason: "线下收款补录",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/wallets");
  });
});
