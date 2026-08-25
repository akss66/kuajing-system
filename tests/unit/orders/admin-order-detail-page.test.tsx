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
  cancelAllCancellableOrderShipmentsAction: vi.fn(),
  cancelJifengShipmentAction: vi.fn(),
  completeAllOfflineOrderRefundsAction: vi.fn(),
  completeOfflinePackageRefundAction: vi.fn(),
  createReplacementAction: vi.fn(),
  refreshAllJifengShipmentStatusesAction: vi.fn(),
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
    expect(screen.getByText("ERP-1")).toBeVisible();
    expect(screen.getByText("TRACK-1")).toBeVisible();
    expect(screen.getByRole("group", { name: "补发包裹工作区" })).not.toHaveAttribute("open");
  });

  it("keeps a matched Jifeng order as a compact manual-action summary", async () => {
    queryMocks.getAdminOrderDetail.mockResolvedValue({
      adjustedAmountFen: 0,
      cancelReason: null,
      cancellationState: "NONE",
      createdAt: new Date("2026-08-24T02:00:00.000Z"),
      customerCode: "C-004",
      customerName: "待提交客户",
      id: "order-4",
      netAmountFen: 1700,
      orderNumber: "TH-20260824-MANUAL",
      paidAt: new Date("2026-08-24T02:01:00.000Z"),
      paymentMode: "DIRECT_OFFLINE",
      refundedAt: null,
      shipments: [
        {
          attemptCount: 1,
          cancellationAdjustment: null,
          cancelledAt: null,
          erpNo: "OPNJ-1",
          externalOrderNo: "PO-MANUAL-1",
          fulfillmentId: "fulfillment-manual",
          fulfillmentStatus: "PENDING",
          id: "00000000-0000-4000-8000-000000000005",
          jifengStatus: null,
          kind: "NORMAL",
          lastErrorCode: "50017",
          lastErrorMessage: null,
          lines: [],
          logisticsCurrency: null,
          logisticsFeeMinor: null,
          nextRetryAt: new Date("2026-08-24T02:05:00.000Z"),
          replacementReason: null,
          replacementStatus: null,
          shippedAt: null,
          trackingNumber: null,
        },
      ],
      status: "FULFILLING",
      storeName: "店铺四",
      totalAmountFen: 1700,
      totalPackageCount: 1,
      totalQuantity: 1,
    });

    render(
      await AdminOrderDetailPage({
        params: Promise.resolve({ orderId: "order-4" }),
      }),
    );

    expect(screen.getByText("待在极风后台提交仓库")).toBeVisible();
    expect(
      screen.getByText(
        "已匹配到极风订单，请在极风后台选择物流渠道并提交仓库；系统随后自动同步。",
      ),
    ).toBeVisible();
    expect(screen.getByText("OPNJ-1")).toBeVisible();
    expect(screen.getByRole("group", { name: "普通包裹 1工作区" })).toHaveAttribute("open");
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
    expect(screen.getByRole("group", { name: "普通包裹 1工作区" })).toHaveAttribute("open");
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

  it("renders whole-order query, cancellation, and offline refund controls together", async () => {
    queryMocks.getAdminOrderDetail.mockResolvedValue({
      adjustedAmountFen: 1700,
      cancelReason: null,
      cancellationState: "PARTIAL",
      createdAt: new Date("2026-08-25T01:00:00.000Z"),
      customerCode: "C-005",
      customerName: "整单操作客户",
      id: "order-5",
      netAmountFen: 2300,
      orderNumber: "TH-20260825-OPS",
      paidAt: new Date("2026-08-25T01:01:00.000Z"),
      paymentMode: "DIRECT_OFFLINE",
      refundedAt: null,
      shipments: [
        {
          attemptCount: 1,
          cancellationAdjustment: {
            id: "adjustment-1",
            note: null,
            offlineAmountFen: 1700,
            refundedAmountFen: 1700,
            shipmentId: "00000000-0000-4000-8000-000000000006",
            status: "PENDING_OFFLINE",
          },
          cancelledAt: null,
          erpNo: "ERP-OPS-1",
          externalOrderNo: "PO-OPS-1",
          fulfillmentId: "fulfillment-ops-1",
          fulfillmentStatus: "EXCEPTION",
          id: "00000000-0000-4000-8000-000000000006",
          jifengStatus: 8,
          kind: "NORMAL",
          lastErrorCode: "50026",
          lastErrorMessage: "库存不足",
          lines: [],
          logisticsCurrency: null,
          logisticsFeeMinor: null,
          nextRetryAt: new Date("2026-08-25T01:05:00.000Z"),
          replacementReason: null,
          replacementStatus: null,
          shippedAt: null,
          trackingNumber: null,
        },
        {
          attemptCount: 0,
          cancellationAdjustment: null,
          cancelledAt: null,
          erpNo: "ERP-OPS-2",
          externalOrderNo: "PO-OPS-2",
          fulfillmentId: "fulfillment-ops-2",
          fulfillmentStatus: "PENDING",
          id: "00000000-0000-4000-8000-000000000007",
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
      storeName: "店铺五",
      totalAmountFen: 4000,
      totalPackageCount: 2,
      totalQuantity: 2,
    });

    render(
      await AdminOrderDetailPage({
        params: Promise.resolve({ orderId: "order-5" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "整单操作" })).toBeVisible();
    expect(screen.getByRole("button", { name: "一键查询整单状态" })).toBeVisible();
    expect(screen.getByRole("button", { name: "取消全部可取消包裹" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认全部退款完成" })).toBeVisible();
    expect(screen.getByPlaceholderText("填写本次整单取消原因")).toBeVisible();
    expect(screen.getByPlaceholderText("填写退款流水号、时间或批次备注")).toBeVisible();
  });
});
