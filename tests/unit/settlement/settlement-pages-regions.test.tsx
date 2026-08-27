// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const orderQueryMocks = vi.hoisted(() => ({ listAdminOrderFilterOptions: vi.fn() }));
const settlementQueryMocks = vi.hoisted(() => ({ listAdminSettlementBatches: vi.fn() }));
const walletQueryMocks = vi.hoisted(() => ({ getCustomerWalletView: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={String(href)} {...props}>{children}</a>,
}));
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/orders/queries", () => orderQueryMocks);
vi.mock("@/modules/settlement/admin-queries", () => settlementQueryMocks);
vi.mock("@/modules/wallet/queries", () => walletQueryMocks);

import AdminSettlementBatchesPage from "@/app/(admin)/admin/settlement-batches/page";
import CustomerWalletPage from "@/app/(customer)/portal/wallet/page";

describe("settlement page regions", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1", userId: "user-1" });
    orderQueryMocks.listAdminOrderFilterOptions.mockResolvedValue({ customers: [], stores: [] });
    settlementQueryMocks.listAdminSettlementBatches.mockResolvedValue([]);
    walletQueryMocks.getCustomerWalletView.mockResolvedValue({
      activeHoldFen: 0,
      availableFen: 168800,
      balanceFen: 168800,
      holds: [],
      transactions: [],
    });
  });

  afterEach(() => cleanup());

  it("gives the batch list one named financial region", async () => {
    render(await AdminSettlementBatchesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("region", { name: "合并付款记录" })).toBeVisible();
  });

  it("collapses an empty wallet into one useful activity state", async () => {
    render(await CustomerWalletPage());

    expect(screen.getByRole("heading", { level: 1, name: "资金中心" })).toBeVisible();
    expect(screen.getByRole("region", { name: "客户余额" })).toBeVisible();
    expect(screen.getByText("可用余额")).toBeVisible();
    expect(screen.getByText("订单预留")).toBeVisible();
    expect(screen.queryByText("流水条数")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "资金记录" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "订单预留金额" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "资金流水" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "还没有资金记录" })).toBeVisible();
    expect(screen.getByRole("link", { name: "查看我的订单" })).toHaveAttribute("href", "/portal/orders");
    expect(document.querySelectorAll("[data-wallet-activity]")).toHaveLength(1);
    expect(document.querySelector("[data-wallet-activity-groups]")).not.toBeInTheDocument();
    expect(screen.queryByText("付款说明")).not.toBeInTheDocument();
    expect(screen.queryByText("先看可用余额，再处理需要补付的订单")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看待付款订单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开合并付款记录" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("批量付款冻结");
  });

  it("keeps payment links and immutable wallet rows available in the compact activity surface", async () => {
    walletQueryMocks.getCustomerWalletView.mockResolvedValueOnce({
      activeHoldFen: 2500,
      availableFen: 97500,
      balanceFen: 100000,
      holds: [{
        amountFen: 2500,
        batchNumber: "PAY-001",
        createdAt: new Date("2026-08-25T06:00:00.000Z"),
        id: "hold-1",
        releaseReason: null,
        releasedAt: null,
        settlementBatchId: "batch-1",
        status: "ACTIVE",
      }],
      transactions: [{
        afterBalanceFen: 100000,
        createdAt: new Date("2026-08-25T05:00:00.000Z"),
        deltaFen: 2500,
        id: "transaction-1",
        orderNumber: "TH-20260825-001",
        reason: "管理员人工入账",
        transactionType: "MANUAL_CREDIT",
      }],
    });

    render(await CustomerWalletPage());

    expect(screen.getByText("付款编号 PAY-001")).toBeVisible();
    expect(screen.getByText("冻结中")).toBeVisible();
    expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "订单预留金额" })).toBeVisible();
    expect(screen.getByRole("link", { name: "查看付款" })).toHaveAttribute("href", "/portal/settlements/batch-1");
    expect(screen.getByText("管理员人工入账")).toBeVisible();
    expect(screen.getByText("+¥25.00")).toBeVisible();
    expect(screen.getByText("TH-20260825-001")).toBeVisible();
    expect(screen.getAllByText("1 笔")).toHaveLength(2);
  });
});
