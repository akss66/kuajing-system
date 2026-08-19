// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  getAdminOrderDetail: vi.fn(),
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

vi.mock("@/modules/fulfillment/actions", () => ({
  cancelJifengShipmentAction: vi.fn(),
  createReplacementAction: vi.fn(),
  retryJifengShipmentAction: vi.fn(),
}));

vi.mock("@/modules/orders/queries", () => queryMocks);

import AdminOrderDetailPage from "@/app/(admin)/admin/orders/[orderId]/page";

describe("AdminOrderDetailPage", () => {
  beforeEach(() => {
    queryMocks.getAdminOrderDetail.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps a visible back link and renders each heading metric only once", async () => {
    queryMocks.getAdminOrderDetail.mockResolvedValue({
      cancelReason: null,
      createdAt: new Date("2026-08-12T10:00:00.000Z"),
      customerCode: "C-001",
      customerName: "订单客户",
      id: "order-1",
      orderNumber: "TH-20260812-ORDER-1",
      paymentMode: "DIRECT_OFFLINE",
      shipments: [
        {
          attemptCount: 1,
          cancelledAt: null,
          erpNo: "ERP-1",
          externalOrderNo: "TEMU-1",
          fulfillmentId: "fulfillment-1",
          fulfillmentStatus: "SHIPPED",
          id: "shipment-1",
          jifengStatus: 7,
          kind: "REPLACEMENT",
          lastErrorCode: null,
          lastErrorMessage: null,
          lines: [
            {
              id: "line-1",
              lineAmountFen: 1000,
              quantity: 2,
              shipmentId: "shipment-1",
              skuCode: "SKU-1",
              skuId: "sku-1",
              skuName: "订单商品",
              unitPriceFen: 500,
              unitPriceMilliYuan: 5_000,
            },
          ],
          logisticsCurrency: "CAD",
          logisticsFeeMinor: 899,
          nextRetryAt: null,
          replacementReason: null,
          replacementStatus: "FULFILLING",
          shippedAt: new Date("2026-08-12T11:00:00.000Z"),
          trackingNumber: "TRACK-1",
        },
      ],
      status: "SHIPPED",
      storeName: "店铺一",
      totalAmountFen: 1000,
      totalPackageCount: 1,
      totalQuantity: 2,
    });

    render(
      await AdminOrderDetailPage({
        params: Promise.resolve({ orderId: "order-1" }),
      }),
    );

    expect(screen.getByRole("link", { name: "返回订单列表" })).toBeVisible();
    expect(screen.getAllByText("包裹数")).toHaveLength(1);
    expect(screen.getAllByText("商品件数")).toHaveLength(1);
    expect(screen.getAllByText("实际成交额")).toHaveLength(1);
    expect(screen.getAllByText("创建时间")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "订单状态时间线" })).toBeVisible();
    expect(screen.getAllByText("补发待仓库发货")).toHaveLength(2);
    expect(screen.queryByText("FULFILLING")).not.toBeInTheDocument();
  });

  it("presents retry and cancellation as independent package operations", async () => {
    queryMocks.getAdminOrderDetail.mockResolvedValue({
      cancelReason: null,
      createdAt: new Date("2026-08-19T02:00:00.000Z"),
      customerCode: "C-002",
      customerName: "多包裹客户",
      id: "order-2",
      orderNumber: "TH-20260819-MULTI",
      paidAt: new Date("2026-08-19T02:01:00.000Z"),
      paymentMode: "DIRECT_OFFLINE",
      refundedAt: null,
      shipments: [
        {
          attemptCount: 1,
          cancelledAt: null,
          erpNo: "ERP-FAILED",
          externalOrderNo: "PO-FAILED",
          fulfillmentId: "fulfillment-failed",
          fulfillmentStatus: "EXCEPTION",
          id: "00000000-0000-4000-8000-000000000001",
          jifengStatus: null,
          kind: "NORMAL",
          lastErrorCode: "50026",
          lastErrorMessage: "库存不足",
          lines: [],
          logisticsCurrency: null,
          logisticsFeeMinor: null,
          nextRetryAt: null,
          replacementReason: null,
          replacementStatus: null,
          shippedAt: null,
          trackingNumber: null,
        },
        {
          attemptCount: 0,
          cancelledAt: null,
          erpNo: "ERP-PENDING",
          externalOrderNo: "PO-PENDING",
          fulfillmentId: "fulfillment-pending",
          fulfillmentStatus: "PENDING",
          id: "00000000-0000-4000-8000-000000000002",
          jifengStatus: null,
          kind: "NORMAL",
          lastErrorCode: null,
          lastErrorMessage: null,
          lines: [],
          logisticsCurrency: null,
          logisticsFeeMinor: null,
          nextRetryAt: null,
          replacementReason: null,
          replacementStatus: null,
          shippedAt: null,
          trackingNumber: null,
        },
      ],
      status: "FULFILLMENT_EXCEPTION",
      storeName: "店铺二",
      totalAmountFen: 1800,
      totalPackageCount: 2,
      totalQuantity: 2,
    });

    render(
      await AdminOrderDetailPage({
        params: Promise.resolve({ orderId: "order-2" }),
      }),
    );

    expect(screen.getAllByRole("button", { name: "取消此包裹" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "重试这个包裹" })).toBeVisible();
  });
});
