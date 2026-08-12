// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  getCustomerSettlementDetail: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/components/settlement/settlement-payment-form", () => ({
  SettlementPaymentForm: () => (
    <form id="settlement-payment-form" tabIndex={-1}>
      <label htmlFor="settlement-payment-note">付款备注（选填）</label>
      <input id="settlement-payment-note" name="note" />
    </form>
  ),
}));

vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/settlement/queries", () => queryMocks);

import CustomerSettlementDetailPage from "@/app/(customer)/portal/settlements/[settlementId]/page";

describe("CustomerSettlementDetailPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("renders Chinese settlement labels and a skip link without exposing raw enums", async () => {
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
    queryMocks.getCustomerSettlementDetail.mockResolvedValue({
      batchNumber: "BATCH-20260812-01",
      claim: {
        id: "claim-1",
        status: "PENDING",
        note: "微信已付款",
        amountFen: 168800,
        createdAt: new Date("2026-08-12T09:11:00.000Z"),
        rejectionReason: null,
        reviewedAt: null,
        withdrawalReason: null,
        withdrawnAt: null,
      },
      id: "batch-1",
      offlineAmountFen: 168800,
      orders: [
        {
          offlineAmountFen: 68800,
          orderId: "order-1",
          orderNumber: "FH-20260812-01",
          status: "PAID_PENDING_FULFILLMENT",
          totalAmountFen: 88800,
          walletAmountFen: 20000,
        },
      ],
      paidAt: null,
      paymentDueAt: new Date("2026-08-12T12:00:00.000Z"),
      status: "PENDING_PAYMENT",
      totalAmountFen: 188800,
      walletAmountFen: 20000,
      walletHold: {
        amountFen: 20000,
        consumedAt: null,
        id: "hold-1",
        releaseReason: null,
        releasedAt: null,
        status: "ACTIVE",
      },
    });

    render(
      await CustomerSettlementDetailPage({
        params: Promise.resolve({ settlementId: "batch-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "统一付款结算" })).toBeInTheDocument();
    const skipLink = screen.getByRole("link", { name: "跳到付款声明" });
    expect(skipLink).toHaveAttribute("href", "#settlement-payment-form");
    fireEvent.click(skipLink);
    const target = document.getElementById("settlement-payment-form");
    expect(target).toHaveAttribute("tabindex", "-1");
    target?.focus();
    expect(target).toHaveFocus();
    expect(screen.getAllByText("待付款").length).toBeGreaterThan(0);
    expect(screen.getByText("已付款 / 待发货")).toBeInTheDocument();
    expect(screen.getByText(/冻结中/)).toBeInTheDocument();
    expect(screen.queryByText("PENDING_PAYMENT")).not.toBeInTheDocument();
    expect(screen.queryByText("PAID_PENDING_FULFILLMENT")).not.toBeInTheDocument();
    expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
  });

  it("keeps the payment declaration skip target focusable without a claim", async () => {
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
    queryMocks.getCustomerSettlementDetail.mockResolvedValue({
      batchNumber: "BATCH-20260812-02",
      claim: null,
      id: "batch-2",
      offlineAmountFen: 168800,
      orders: [],
      paidAt: null,
      paymentDueAt: new Date("2026-08-12T12:00:00.000Z"),
      status: "PENDING_PAYMENT",
      totalAmountFen: 188800,
      walletAmountFen: 20000,
      walletHold: null,
    });

    render(
      await CustomerSettlementDetailPage({
        params: Promise.resolve({ settlementId: "batch-2" }),
      }),
    );

    const skipLink = screen.getByRole("link", { name: "跳到付款声明" });
    fireEvent.click(skipLink);
    const target = document.getElementById("settlement-payment-form");
    expect(target).toHaveAttribute("tabindex", "-1");
    target?.focus();
    expect(target).toHaveFocus();
  });
});
