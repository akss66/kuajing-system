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

describe("settlement workspace hierarchy", () => {
  beforeEach(() => {
    authMocks.requireAdmin.mockResolvedValue({ kind: "SUPER_ADMIN", userId: "super-admin-1" });
  });

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
    expect(screen.getByRole("combobox", { name: "操作" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "核对并调整余额" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认执行余额调整？")).toBeVisible();
    expect(screen.getByRole("button", { name: "返回检查" })).toBeVisible();
  });

  it("keeps balance mutation controls unavailable to an ordinary administrator", async () => {
    authMocks.requireAdmin.mockResolvedValueOnce({ kind: "ADMIN", userId: "admin-1" });
    orderQueryMocks.listPendingPaymentClaims.mockResolvedValue([]);
    settlementQueryMocks.listAdminSettlementBatches.mockResolvedValue([]);
    settlementQueryMocks.listPendingOfflineRefunds.mockResolvedValue([]);
    walletQueryMocks.listAdminWalletAccounts.mockResolvedValue([]);
    walletQueryMocks.listAdminWalletTransactions.mockResolvedValue([]);

    render(await SettlementPage());

    expect(screen.queryByRole("button", { name: "核对并调整余额" })).not.toBeInTheDocument();
    expect(screen.getByText("余额调整仅限超级管理员操作")).toBeVisible();
  });
});
