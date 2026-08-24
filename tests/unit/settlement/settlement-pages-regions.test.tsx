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

    expect(screen.getByRole("region", { name: "批量付款记录" })).toBeVisible();
  });

  it("separates wallet balance, holds and immutable transactions", async () => {
    render(await CustomerWalletPage());

    expect(screen.getByRole("region", { name: "客户余额" })).toBeVisible();
    expect(screen.getByText("可用余额")).toBeVisible();
    expect(screen.queryByText("流水条数")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "批量付款冻结" })).toBeVisible();
    expect(screen.getByRole("region", { name: "资金流水" })).toBeVisible();
  });
});
