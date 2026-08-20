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
  refreshJifengShipmentStatusAction: vi.fn(),
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
    expect(screen.getAllByText("当前净额")).toHaveLength(1);
    expect(screen.getAllByText("取消调整")).toHaveLength(1);
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
          lastErrorCode: "MANUAL_CONFIRMED_FAILURE_RETRY",
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
    expect(screen.getByText("已提交重试，等待系统处理")).toBeVisible();
    expect(
      screen.queryByText("MANUAL_CONFIRMED_FAILURE_RETRY"),
    ).not.toBeInTheDocument();
  });

  it("offers status recovery for a warehouse exception and a stale cancelled package", async () => {
    queryMocks.getAdminOrderDetail.mockResolvedValue({
      adjustedAmountFen: 0,
      cancelReason: null,
      cancellationState: "NONE",
      createdAt: new Date("2026-08-18T02:00:00.000Z"),
      customerCode: "C-003",
      customerName: "异常恢复客户",
      id: "order-3",
      netAmountFen: 3600,
      orderNumber: "TH-20260818-RECOVERY",
      paidAt: new Date("2026-08-18T02:01:00.000Z"),
      paymentMode: "DIRECT_OFFLINE",
      refundedAt: null,
      shipments: [
        {
          attemptCount: 3,
          cancellationAdjustment: null,
          cancelledAt: null,
          erpNo: "ERP-WAREHOUSE-ERROR",
          externalOrderNo: "PO-WAREHOUSE-ERROR",
          fulfillmentId: "fulfillment-error",
          fulfillmentStatus: "EXCEPTION",
          id: "00000000-0000-4000-8000-000000000003",
          jifengStatus: 8,
          kind: "NORMAL",
          lastErrorCode: "8",
          lastErrorMessage: "internal warehouse message",
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
          attemptCount: 4,
          cancellationAdjustment: null,
          cancelledAt: new Date("2026-08-18T03:00:00.000Z"),
          erpNo: "ERP-CANCELLED",
          externalOrderNo: "PO-CANCELLED",
          fulfillmentId: "fulfillment-cancelled",
          fulfillmentStatus: "CANCELLED",
          id: "00000000-0000-4000-8000-000000000004",
          jifengStatus: 9,
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
      storeName: "店铺三",
      totalAmountFen: 3600,
      totalPackageCount: 2,
      totalQuantity: 2,
    });

    render(
      await AdminOrderDetailPage({
        params: Promise.resolve({ orderId: "order-3" }),
      }),
    );

    expect(screen.getByRole("button", { name: "重新查询极风状态" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新核对取消状态" })).toBeVisible();
    expect(screen.getByRole("button", { name: "取消此包裹" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "重试这个包裹" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("直接读取极风当前结果并更新本包裹；不会重复创建订单。"),
    ).toHaveLength(2);
  });
});
