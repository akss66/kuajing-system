// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orderQueryMocks = vi.hoisted(() => ({
  listPendingPaymentClaims: vi.fn(),
}));

const settlementQueryMocks = vi.hoisted(() => ({
  listAdminSettlementBatches: vi.fn(),
  listPendingOfflineRefunds: vi.fn(),
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
    settlementQueryMocks.listPendingOfflineRefunds.mockResolvedValue([
      {
        createdAt: new Date("2026-08-10T04:00:00.000Z"),
        customerCode: "C-001",
        customerName: "客户一",
        externalOrderNo: "PO-10001",
        offlineAmountFen: 1_300,
        orderId: "order-1",
        orderNumber: "TH-20260810-001",
        shipmentId: "shipment-1",
      },
    ]);
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
    expect(screen.getByRole("region", { name: "待线下退款" })).toBeVisible();
    expect(screen.getByRole("region", { name: "客户余额" })).toBeVisible();
    expect(screen.getByRole("region", { name: "结算批次" })).toBeVisible();
    expect(screen.getByRole("region", { name: "资金流水" })).toBeVisible();
    expect(screen.getByText("PO-10001")).toBeVisible();
    expect(screen.getByText("¥13.00")).toBeVisible();
    expect(screen.getByRole("link", { name: /进入订单详情处理/ })).toHaveAttribute(
      "href",
      "/admin/orders/order-1",
    );
  });
});
