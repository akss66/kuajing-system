// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OrderStatusPanel } from "@/components/orders/order-status-panel";
import type { CustomerOrderDetail } from "@/modules/orders/queries";

function paidOrder(input: {
  offlineAmountFen?: number | null;
  paymentMode: "DIRECT_OFFLINE" | "MIXED" | "WALLET";
  shipmentStatuses?: string[];
  status?: "FULFILLING" | "PAID_PENDING_FULFILLMENT" | "SHIPPED";
  walletAmountFen?: number | null;
}) {
  return {
    cancelReason: null,
    cancellationAdjustments: [],
    cancellationState: "NONE",
    createdAt: new Date("2026-08-21T01:00:00.000Z"),
    id: "order-1",
    latestPaymentClaim: null,
    lines: [],
    lockExpiresAt: null,
    netAmountFen: 500,
    offlineAmountFen: input.offlineAmountFen ?? null,
    orderNumber: "TZX-MIXED-1",
    paidAt: new Date("2026-08-21T02:00:00.000Z"),
    paymentMode: input.paymentMode,
    refundedAt: null,
    shipments: (input.shipmentStatuses ?? []).map((fulfillmentStatus, index) => ({
      fulfillmentStatus,
      id: `shipment-${index + 1}`,
      kind: "NORMAL",
      replacementStatus: null,
    })),
    status: input.status ?? "PAID_PENDING_FULFILLMENT",
    storeName: "混合结算店铺",
    totalAmountFen: 500,
    totalPackageCount: 1,
    totalQuantity: 1,
    walletAmountFen: input.walletAmountFen ?? null,
  } as unknown as CustomerOrderDetail;
}

describe("OrderStatusPanel payment facts", () => {
  afterEach(cleanup);

  it("shows the order-level mixed allocation instead of denying wallet activity", () => {
    render(
      <OrderStatusPanel
        order={paidOrder({
          offlineAmountFen: 300,
          paymentMode: "MIXED",
          walletAmountFen: 200,
        })}
      />,
    );

    expect(screen.getByText("余额扣除 ¥2.00，微信确认 ¥3.00。")).toBeVisible();
    expect(screen.queryByText(/本单未经过钱包充值和扣款/)).not.toBeInTheDocument();
  });

  it("shows a zero wallet allocation accurately inside a mixed batch", () => {
    render(
      <OrderStatusPanel
        order={paidOrder({
          offlineAmountFen: 500,
          paymentMode: "MIXED",
          walletAmountFen: 0,
        })}
      />,
    );

    expect(screen.getByText("余额扣除 ¥0.00，微信确认 ¥5.00。")).toBeVisible();
    expect(screen.queryByText(/本单未经过钱包充值和扣款/)).not.toBeInTheDocument();
  });

  it("preserves historical wallet and direct-offline descriptions", () => {
    const { rerender } = render(
      <OrderStatusPanel order={paidOrder({ paymentMode: "WALLET" })} />,
    );
    expect(
      screen.getByText("客户余额已自动扣除，无需管理员再次确认。"),
    ).toBeVisible();

    rerender(
      <OrderStatusPanel order={paidOrder({ paymentMode: "DIRECT_OFFLINE" })} />,
    );
    expect(
      screen.getByText("管理员已确认微信付款到账，本单未经过钱包充值和扣款。"),
    ).toBeVisible();
  });

  it.each([
    {
      expected: "包裹取消处理中，待仓库确认",
      shipmentStatuses: ["CANCEL_PENDING"],
      status: "FULFILLING" as const,
    },
    {
      expected: "同舟行正在匹配仓库订单",
      shipmentStatuses: ["SUBMITTING"],
      status: "FULFILLING" as const,
    },
    {
      expected: "同舟行正在提交仓库",
      shipmentStatuses: ["SUBMITTED"],
      status: "FULFILLING" as const,
    },
    {
      expected: "仓库已接单，正在处理发货",
      shipmentStatuses: ["FULFILLING"],
      status: "FULFILLING" as const,
    },
    { expected: "包裹已发货，可留意后续物流状态", status: "SHIPPED" as const },
  ])("uses real shipment progress instead of overclaiming $status", ({ expected, shipmentStatuses, status }) => {
    render(
      <OrderStatusPanel
        order={paidOrder({ paymentMode: "WALLET", shipmentStatuses, status })}
      />,
    );

    expect(screen.getByRole("heading", { name: expected })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "付款已完成，等待同舟行发货" }),
    ).not.toBeInTheDocument();
  });
});
