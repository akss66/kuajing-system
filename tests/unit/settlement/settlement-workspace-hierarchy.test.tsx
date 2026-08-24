// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
}));

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
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/settlement/admin-queries", () => settlementQueryMocks);
vi.mock("@/modules/wallet/queries", () => walletQueryMocks);
vi.mock("@/modules/wallet/actions", () => ({ adjustWalletAction: vi.fn() }));
vi.mock("@/components/orders/payment-claim-review", () => ({
  PaymentClaimReview: () => null,
}));

import SettlementPage from "@/app/(admin)/admin/settlement/page";
import AdminWalletsPage from "@/app/(admin)/admin/wallets/page";

describe("settlement workspace hierarchy", () => {
  beforeEach(() => {
    authMocks.requireAdmin.mockResolvedValue({ kind: "ADMIN", userId: "admin-1" });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps collection work focused on payment review and refunds", async () => {
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
        updatedAt: new Date("2026-08-10T05:00:00.000Z"),
      },
    ]);
    walletQueryMocks.listAdminWalletTransactions.mockResolvedValue([
      {
        afterBalanceFen: 168800,
        beforeBalanceFen: 158800,
        createdAt: new Date("2026-08-10T05:00:00.000Z"),
        customerCode: "C-001",
        customerName: "客户一",
        deltaFen: 10000,
        id: "transaction-1",
        orderNumber: null,
        reason: "线下充值",
        transactionType: "ADMIN_CREDIT",
      },
    ]);

    render(await SettlementPage());

    expect(screen.getByRole("heading", { level: 1, name: "收款审核" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "资金管理" })).toBeVisible();
    expect(screen.getByRole("region", { name: "单张拿货单待核款" })).toBeVisible();
    expect(screen.getByRole("region", { name: "待线下退款" })).toBeVisible();
    expect(screen.getByRole("region", { name: "合并付款审核" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "客户余额" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "资金流水" })).not.toBeInTheDocument();
    expect(screen.getByText("PO-10001")).toBeVisible();
    expect(screen.getByText("¥13.00")).toBeVisible();
    expect(screen.getByRole("link", { name: /进入订单详情处理/ })).toHaveAttribute(
      "href",
      "/admin/orders/order-1",
    );
    expect(screen.queryByText("批量草稿诊断")).not.toBeInTheDocument();
  });

  it("gives ordinary system administrators a visible, confirmed balance workspace", async () => {
    walletQueryMocks.listAdminWalletAccounts.mockResolvedValue([{
      balanceFen: 168800,
      customerCode: "C-001",
      customerId: "11111111-1111-4111-8111-111111111111",
      customerName: "客户一",
      status: "ACTIVE",
      updatedAt: new Date("2026-08-10T05:00:00.000Z"),
    }]);
    walletQueryMocks.listAdminWalletTransactions.mockResolvedValue([]);

    render(await AdminWalletsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { level: 1, name: "客户余额" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "调整客户余额" })).toBeVisible();
    expect(screen.getByRole("button", { name: "核对并调整" })).toBeVisible();
    expect(screen.getByRole("table", { name: "客户余额账户" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "核对并调整" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认执行余额调整？")).toBeVisible();
  });
});
