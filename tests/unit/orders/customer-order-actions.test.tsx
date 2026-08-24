// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      expect(screen.getByRole("heading", { name: "完成批量付款" })).toBeVisible();
      expect(
        screen.getByText("本单已包含在一次批量付款中，请在批量付款页面完成支付。"),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: "查看本次批量付款" })).toBeVisible();
    },
  );

  test("allows order payment after the old settlement batch is terminal", () => {
    render(<CustomerOrderActions order={orderWithSettlement("CANCELLED")} />);

    expect(screen.getByRole("button", { name: "我已微信付款" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "完成批量付款" })).not.toBeInTheDocument();
  });

  test("keeps payment primary and protects cancellation behind secondary actions", () => {
    render(<CustomerOrderActions order={orderWithSettlement(null)} />);

    expect(screen.getByRole("region", { name: "订单下一步" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "完成付款" })).toBeVisible();
    expect(screen.getByRole("button", { name: "我已微信付款" })).toBeVisible();

    const secondaryActions = screen.getByRole("group", { name: "其他操作" });
    expect(secondaryActions).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "确认取消" })).not.toBeVisible();

    fireEvent.click(screen.getByText("其他操作"));

    expect(secondaryActions).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "确认取消" })).toBeVisible();
  });
});
