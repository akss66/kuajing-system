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

    fireEvent.click(within(filters).getByRole("button", { name: "更多筛选" }));
    const drawer = await screen.findByRole("dialog", { name: "更多订单筛选" });
    expect(within(drawer).getByLabelText("开始日期")).toHaveValue("2026-08-01");
    expect(within(drawer).getByRole("button", { name: "关闭" })).toBeVisible();
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

    const card = screen.getByRole("article", { name: "订单 FH-20260812-01" });
    expect(card).toHaveAttribute("data-mobile-order-card");
    expect(within(card).getByText("多伦多一店")).toBeVisible();
    expect(within(card).getByText("¥1688.00")).toBeVisible();
    expect(within(card).getByText("待付款")).toBeVisible();
    expect(within(card).getByText("下一步：去付款")).toBeVisible();
    expect(within(card).getByRole("link", { name: "去付款" })).toHaveClass("min-h-11");
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
});
