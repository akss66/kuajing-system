// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/modules/orders/lifecycle-actions", () => ({
  cancelCustomerOrderAction: vi.fn(),
  declareOfflinePaymentAction: vi.fn(),
}));

import { CustomerOrderActions } from "@/components/orders/customer-order-actions";
import type { CustomerOrderDetail } from "@/modules/orders/queries";

function orderWithSettlement(
  status: CustomerOrderDetail["settlementBatchStatus"],
): CustomerOrderDetail {
  return {
    adjustedAmountFen: 0,
    cancelReason: null,
    cancellationAdjustments: [],
    cancellationState: "NONE",
    createdAt: new Date("2026-08-12T10:00:00.000Z"),
    id: crypto.randomUUID(),
    latestPaymentClaim: {
      amountFen: 500,
      createdAt: new Date("2026-08-12T09:00:00.000Z"),
      id: crypto.randomUUID(),
      note: null,
      rejectionReason: "旧声明已拒绝",
      reviewedAt: new Date("2026-08-12T09:30:00.000Z"),
      status: "REJECTED",
    },
    lines: [],
    lockExpiresAt: new Date("2026-08-12T12:00:00.000Z"),
    netAmountFen: 500,
    offlineAmountFen: status ? 500 : null,
    orderNumber: "TZX-UI-GUARD",
    paidAt: null,
    paymentMode: null,
    refundedAt: null,
    settlementBatchId: status ? crypto.randomUUID() : null,
    settlementBatchStatus: status,
    shipments: [],
    status: "PENDING_PAYMENT",
    storeName: "测试店铺",
    totalAmountFen: 500,
    totalPackageCount: 1,
    totalQuantity: 1,
    walletAmountFen: status ? 0 : null,
  };
}

describe("CustomerOrderActions", () => {
  afterEach(cleanup);

  test.each(["PENDING_PAYMENT", "PAYMENT_REPORTED"] as const)(
    "hides the order payment form for an active %s settlement",
    (status) => {
      render(<CustomerOrderActions order={orderWithSettlement(status)} />);

      expect(screen.queryByRole("button", { name: "我已微信付款" })).not.toBeInTheDocument();
      expect(screen.getByText("请在统一结算批次中申报付款")).toBeInTheDocument();
    },
  );

  test("allows order payment after the old settlement batch is terminal", () => {
    render(<CustomerOrderActions order={orderWithSettlement("CANCELLED")} />);

    expect(screen.getByRole("button", { name: "我已微信付款" })).toBeInTheDocument();
    expect(screen.queryByText("请在统一结算批次中申报付款")).not.toBeInTheDocument();
  });
});
