// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orderQueryMocks = vi.hoisted(() => ({
  listPendingPaymentClaims: vi.fn(),
}));

const settlementQueryMocks = vi.hoisted(() => ({
  listAdminSettlementBatches: vi.fn(),
}));

const walletQueryMocks = vi.hoisted(() => ({
  listAdminWalletAccounts: vi.fn(),
  listAdminWalletTransactions: vi.fn(),
}));

vi.mock("@/modules/orders/queries", () => orderQueryMocks);
vi.mock("@/modules/settlement/admin-queries", () => settlementQueryMocks);
vi.mock("@/modules/wallet/queries", () => walletQueryMocks);
vi.mock("@/modules/wallet/actions", () => ({ adjustWalletAction: vi.fn() }));
vi.mock("@/components/orders/payment-claim-review", () => ({
  PaymentClaimReview: () => null,
}));

import SettlementPage from "@/app/(admin)/admin/settlement/page";

describe("settlement workspace hierarchy", () => {
  afterEach(() => {
    cleanup();
  });

  it("separates review queue, balances, batches and transactions into named financial regions", async () => {
    orderQueryMocks.listPendingPaymentClaims.mockResolvedValue([]);
    settlementQueryMocks.listAdminSettlementBatches.mockResolvedValue([]);
    walletQueryMocks.listAdminWalletAccounts.mockResolvedValue([
      {
        balanceFen: 168800,
        customerCode: "C-001",
        customerId: "customer-1",
        customerName: "客户一",
        status: "ACTIVE",
      },
    ]);
    walletQueryMocks.listAdminWalletTransactions.mockResolvedValue([]);

    render(await SettlementPage());

    expect(screen.getByRole("region", { name: "待核款队列" })).toBeVisible();
    expect(screen.getByRole("region", { name: "客户余额" })).toBeVisible();
    expect(screen.getByRole("region", { name: "结算批次" })).toBeVisible();
    expect(screen.getByRole("region", { name: "资金流水" })).toBeVisible();
  });
});
