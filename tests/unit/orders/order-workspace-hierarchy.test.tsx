// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  getCustomerOrderDetail: vi.fn(),
  listAdminOrderFilterOptions: vi.fn(),
  listAdminOrders: vi.fn(),
  listCustomerOrders: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
  usePathname: () => "/admin/orders",
  useRouter: () => ({ replace: navigationMocks.replace }),
  useSearchParams: () => navigationMocks.searchParams,
}));

vi.mock("@/components/orders/admin-order-cancel", () => ({
  AdminOrderCancel: () => null,
}));

vi.mock("@/components/orders/customer-order-actions", () => ({
  CustomerOrderActions: () => null,
}));

vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/orders/queries", () => queryMocks);

import AdminOrdersPage from "@/app/(admin)/admin/orders/page";
import CustomerOrderDetailPage from "@/app/(customer)/portal/orders/[orderId]/page";
import CustomerOrdersPage from "@/app/(customer)/portal/orders/page";
import { OrderStatusTimeline } from "@/components/orders/order-status-timeline";

const order = {
  createdAt: new Date("2026-08-12T10:00:00.000Z"),
  id: "order-1",
  lockExpiresAt: new Date("2026-08-12T12:00:00.000Z"),
  orderNumber: "FH-20260812-01",
  paymentMode: "DIRECT_OFFLINE",
  status: "PENDING_PAYMENT",
  storeName: "多伦多一店",
  totalAmountFen: 168800,
  totalPackageCount: 2,
  totalQuantity: 8,
};

describe("order workspace hierarchy", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1", userId: "user-1" });
    navigationMocks.replace.mockReset();
    navigationMocks.searchParams = new URLSearchParams();
    queryMocks.listAdminOrderFilterOptions.mockResolvedValue({
      customers: [{ code: "C-001", id: "customer-1", name: "客户一" }],
      stores: [{ customerId: "customer-1", id: "store-1", name: "多伦多一店" }],
    });
    queryMocks.listAdminOrders.mockResolvedValue([
      { ...order, customerCode: "C-001", customerName: "客户一" },
    ]);
    queryMocks.listCustomerOrders.mockResolvedValue([order]);
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps common order filters to four and moves dates into an accessible drawer", async () => {
    render(
      await AdminOrdersPage({
        searchParams: Promise.resolve({
          customerId: "customer-1",
          dateFrom: "2026-08-01",
          orderNumber: "FH-20260812",
          status: "PENDING_PAYMENT",
          storeId: "store-1",
        }),
      }),
    );

    const filters = screen.getByRole("region", { name: "订单筛选" });
    const commonFilters = within(filters).getAllByTestId("common-order-filter");
    expect(commonFilters.length).toBeGreaterThan(0);
    expect(commonFilters.length).toBeLessThanOrEqual(4);
    expect(within(filters).queryByLabelText("开始日期")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看已取消拿货单" })).toHaveAttribute(
      "href",
      "/admin/orders?status=CANCELLED",
    );

    fireEvent.click(within(filters).getByRole("button", { name: "更多筛选" }));
    const drawer = await screen.findByRole("dialog", { name: "更多订单筛选" });
    expect(within(drawer).getByLabelText("开始日期")).toHaveValue("2026-08-01");
    expect(within(drawer).getByRole("button", { name: "关闭" })).toBeVisible();
  });

  it("keeps cancelled orders in a separate archive with clearly non-operating metrics", async () => {
    queryMocks.listAdminOrders.mockResolvedValueOnce([
      {
        ...order,
        customerCode: "C-001",
        customerName: "客户一",
        status: "CANCELLED",
      },
    ]);

    render(
      await AdminOrdersPage({
        searchParams: Promise.resolve({ status: "CANCELLED" }),
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "已取消拿货单" })).toBeVisible();
    expect(screen.getByText("已取消订单")).toBeVisible();
    expect(screen.getByText("取消前金额")).toBeVisible();
    expect(screen.queryByText("订单金额")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回有效拿货单" })).toHaveAttribute(
      "href",
      "/admin/orders",
    );
  });

  it("lets an administrator select one or many active fulfillment orders for Jifeng export", async () => {
    queryMocks.listAdminOrders.mockResolvedValueOnce([
      {
        ...order,
        customerCode: "C-001",
        customerName: "客户一",
        status: "PAID_PENDING_FULFILLMENT",
      },
    ]);

    render(await AdminOrdersPage({ searchParams: Promise.resolve({}) }));

    const exportRegion = screen.getByRole("region", { name: "极风发货导出" });
    const exportButton = within(exportRegion).getByRole("button", { name: "导出所选拿货单" });
    const orderCheckboxes = screen.getAllByRole("checkbox", { name: "选择拿货单 FH-20260812-01" });

    expect(exportButton).toBeDisabled();
    expect(exportRegion).toHaveTextContent("已选择 0 个拿货单");

    fireEvent.click(orderCheckboxes[0]);

    expect(exportButton).toBeEnabled();
    expect(exportRegion).toHaveTextContent("已选择 1 个拿货单");
  });

  it("does not expose unpaid orders to the Jifeng fulfillment export", async () => {
    render(await AdminOrdersPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.queryByRole("checkbox", { name: "选择拿货单 FH-20260812-01" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("未付款，不可导出")).toHaveLength(2);
  });

  it("removes one active URL filter without losing the others", async () => {
    navigationMocks.searchParams = new URLSearchParams(
      "status=PENDING_PAYMENT&dateFrom=2026-08-01",
    );

    render(
      await AdminOrdersPage({
        searchParams: Promise.resolve({
          dateFrom: "2026-08-01",
          status: "PENDING_PAYMENT",
        }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "移除筛选：开始日期 2026-08-01" }));

    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/admin/orders?status=PENDING_PAYMENT",
      { scroll: false },
    );
  });

  it("renders mobile order cards with store, amount, status and a visible next action", async () => {
    render(await CustomerOrdersPage({ searchParams: Promise.resolve({}) }));

    const filters = screen.getByRole("region", { name: "订单筛选" });
    expect(filters).toHaveAttribute("data-filter-audience", "customer");
    expect(
      within(filters).queryByText(/常用条件先筛一轮/),
    ).not.toBeInTheDocument();
    expect(within(filters).getByRole("button", { name: "筛选" })).toBeVisible();
    expect(within(filters).getByRole("button", { name: "更多筛选" })).toBeVisible();

    const card = screen.getByRole("article", { name: "订单 FH-20260812-01" });
    expect(card).toHaveAttribute("data-mobile-order-card");
    expect(within(card).getByText("多伦多一店")).toBeVisible();
    expect(within(card).getByText("¥1688.00")).toBeVisible();
    expect(within(card).getByText("待付款")).toBeVisible();
    expect(within(card).getByText("下一步：去付款")).toBeVisible();
    expect(within(card).getByRole("link", { name: "去付款" })).toHaveClass("min-h-11");
  });

  it("presents expired admin orders as non-operating archive values", async () => {
    queryMocks.listAdminOrders.mockResolvedValueOnce([
      {
        ...order,
        customerCode: "C-001",
        customerName: "客户一",
        status: "EXPIRED",
      },
    ]);

    render(
      await AdminOrdersPage({
        searchParams: Promise.resolve({ status: "EXPIRED" }),
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "已超时拿货单" })).toBeVisible();
    expect(screen.getByText("已超时订单")).toBeVisible();
    expect(screen.getByText("超时前金额")).toBeVisible();
    expect(screen.queryByText("订单金额")).not.toBeInTheDocument();
  });

  it("presents cancelled customer orders as non-operating archive values", async () => {
    queryMocks.listCustomerOrders.mockResolvedValueOnce([
      { ...order, status: "CANCELLED" },
    ]);

    render(
      await CustomerOrdersPage({
        searchParams: Promise.resolve({ status: "CANCELLED" }),
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "已取消拿货单" })).toBeVisible();
    expect(screen.getByText("已取消订单")).toBeVisible();
    expect(screen.getByText("取消前金额")).toBeVisible();
    expect(screen.queryByText("订单总额")).not.toBeInTheDocument();
  });

  it("presents expired customer orders as non-operating archive values", async () => {
    queryMocks.listCustomerOrders.mockResolvedValueOnce([
      { ...order, status: "EXPIRED" },
    ]);

    render(
      await CustomerOrdersPage({
        searchParams: Promise.resolve({ status: "EXPIRED" }),
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "已超时拿货单" })).toBeVisible();
    expect(screen.getByText("已超时订单")).toBeVisible();
    expect(screen.getByText("超时前金额")).toBeVisible();
    expect(screen.queryByText("订单总额")).not.toBeInTheDocument();
  });

  it("localizes the pending payment review stage in the shared detail timeline", async () => {
    queryMocks.getCustomerOrderDetail.mockResolvedValue({
      ...order,
      cancelReason: null,
      latestPaymentClaim: {
        amountFen: 168800,
        createdAt: new Date("2026-08-12T10:30:00.000Z"),
        id: "claim-1",
        note: null,
        rejectionReason: null,
        reviewedAt: null,
        status: "PENDING",
      },
      lines: [],
      paidAt: null,
      refundedAt: null,
      shipments: [],
    });

    render(
      await CustomerOrderDetailPage({
        params: Promise.resolve({ orderId: "order-1" }),
      }),
    );

    const timeline = screen.getByRole("region", { name: "订单状态时间线" });
    expect(within(timeline).getByText("待核款")).toHaveAttribute("aria-current", "step");
    expect(within(timeline).queryByText("PENDING")).not.toBeInTheDocument();
  });

  it("keeps the customer detail summary focused on money and quantity facts", async () => {
    queryMocks.getCustomerOrderDetail.mockResolvedValue({
      ...order,
      adjustedAmountFen: 1300,
      cancelReason: null,
      cancellationAdjustments: [],
      cancellationState: "PARTIAL",
      latestPaymentClaim: null,
      lines: [],
      netAmountFen: 167500,
      paidAt: new Date("2026-08-12T10:30:00.000Z"),
      refundedAt: null,
      shipments: [],
      status: "PAID_PENDING_FULFILLMENT",
    });

    render(
      await CustomerOrderDetailPage({
        params: Promise.resolve({ orderId: "order-1" }),
      }),
    );

    expect(screen.getByRole("link", { name: "返回我的订单" })).toHaveAttribute(
      "href",
      "/portal/orders",
    );
    expect(screen.getByText("已付款 / 待发货")).toBeVisible();
    expect(screen.getByText("部分取消")).toBeVisible();
    expect(screen.queryByText("订单状态")).not.toBeInTheDocument();
    expect(screen.getByText("当前净额")).toBeVisible();
    expect(screen.getByText("取消调整")).toBeVisible();
  });

  it("keeps payment and proven wallet refund facts visible before cancellation", () => {
    render(
      <OrderStatusTimeline
        orderStatus="CANCELLED"
        paidAt="2026-08-12T10:30:00.000Z"
        refundedAt="2026-08-12T11:00:00.000Z"
      />,
    );

    const timeline = screen.getByRole("region", { name: "订单状态时间线" });
    expect(Array.from(timeline.querySelectorAll("li"), (item) => item.textContent)).toEqual([
      "订单已创建",
      "已付款",
      "余额已退回",
      "已取消",
    ]);
  });

  it("does not claim a refund when a paid cancellation has no refund record", () => {
    render(
      <OrderStatusTimeline
        orderStatus="CANCELLED"
        paidAt="2026-08-12T10:30:00.000Z"
      />,
    );

    const timeline = screen.getByRole("region", { name: "订单状态时间线" });
    expect(Array.from(timeline.querySelectorAll("li"), (item) => item.textContent)).toEqual([
      "订单已创建",
      "已付款",
      "已取消",
    ]);
    expect(within(timeline).queryByText("余额已退回")).not.toBeInTheDocument();
  });

  it("shows real shipment and replacement progress on the customer detail", async () => {
    queryMocks.getCustomerOrderDetail.mockResolvedValue({
      ...order,
      cancelReason: null,
      latestPaymentClaim: null,
      lines: [],
      paidAt: new Date("2026-08-12T10:30:00.000Z"),
      refundedAt: null,
      shipments: [
        {
          fulfillmentStatus: "SHIPPED",
          id: "shipment-1",
          kind: "NORMAL",
          replacementStatus: null,
        },
        {
          fulfillmentStatus: "FULFILLING",
          id: "shipment-2",
          kind: "REPLACEMENT",
          replacementStatus: "FULFILLING",
        },
      ],
      status: "SHIPPED",
    });

    render(
      await CustomerOrderDetailPage({
        params: Promise.resolve({ orderId: "order-1" }),
      }),
    );

    const timeline = screen.getByRole("region", { name: "订单状态时间线" });
    expect(within(timeline).getByText("仓库已发货")).toBeVisible();
    expect(within(timeline).getByText("补发待仓库发货")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("describes warehouse processing exceptions without fulfillment jargon", () => {
    render(
      <OrderStatusTimeline
        orderStatus="FULFILLMENT_EXCEPTION"
        paidAt="2026-08-12T10:30:00.000Z"
        shipmentStatuses={["EXCEPTION"]}
      />,
    );

    const timeline = screen.getByRole("region", { name: "订单状态时间线" });
    expect(within(timeline).getByText("仓库处理异常")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(within(timeline).queryByText("履约异常")).not.toBeInTheDocument();
  });
});
