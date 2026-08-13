// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detailQueryMocks = vi.hoisted(() => ({
  getCustomerManagementDetail: vi.fn(),
  listCustomerManagementRows: vi.fn(),
}));

vi.mock("@/modules/customers/actions", () => ({
  createCustomerWithStoreAction: vi.fn(),
  createStoreAction: vi.fn(),
  setCustomerStatusAction: vi.fn(),
  setStoreStatusAction: vi.fn(),
  updateCustomerAction: vi.fn(),
  updateStoreAction: vi.fn(),
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

vi.mock("@/modules/customers/queries", () => detailQueryMocks);

import CustomerDetailPage from "@/app/(admin)/admin/customers/[customerId]/page";
import CustomersPage from "@/app/(admin)/admin/customers/page";

describe("customer management pages", () => {
  beforeEach(() => {
    detailQueryMocks.getCustomerManagementDetail.mockReset();
    detailQueryMocks.listCustomerManagementRows.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps creation fields inside the drawer and shows every management fact in the customer list", async () => {
    detailQueryMocks.listCustomerManagementRows.mockResolvedValue([
      {
        accountDisplayName: "北区负责人",
        accountEmail: "north-owner@test.local",
        accountStatus: "ACTIVE",
        balanceFen: 123_456,
        code: "NORTH-01",
        contactName: "李青",
        customerId: "customer-1",
        exceptionOrderCount: 0,
        name: "华北客户",
        pendingPaymentFen: 2_500,
        recentOrderCount: 8,
        status: "ACTIVE",
        storeCount: 2,
      },
      {
        accountDisplayName: "暂停账号",
        accountEmail: "paused-owner@test.local",
        accountStatus: "DISABLED",
        balanceFen: 98_700,
        code: "PAUSE-02",
        contactName: null,
        customerId: "customer-2",
        exceptionOrderCount: 2,
        name: "暂停合作客户",
        pendingPaymentFen: 12_300,
        recentOrderCount: 3,
        status: "DISABLED",
        storeCount: 1,
      },
    ]);

    render(await CustomersPage());

    expect(screen.getByRole("heading", { name: "客户与店铺" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新建客户" })).toBeVisible();
    expect(screen.queryByLabelText("客户编号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("登录邮箱")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索客户" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "客户状态筛选" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "店铺数筛选" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更多筛选" })).toBeVisible();

    const table = screen.getByRole("table", { name: "客户列表" });
    for (const header of [
      "客户",
      "唯一登录账号",
      "店铺数",
      "余额",
      "待付款",
      "近 30 天订单",
      "异常",
      "状态",
    ]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeVisible();
    }

    const pausedRow = within(table).getByRole("row", { name: /暂停合作客户/ });
    expect(pausedRow).toHaveTextContent("paused-owner@test.local");
    expect(pausedRow).toHaveTextContent("1 家");
    expect(pausedRow).toHaveTextContent("¥987.00");
    expect(pausedRow).toHaveTextContent("¥123.00");
    expect(pausedRow).toHaveTextContent("3 单");
    expect(pausedRow).toHaveTextContent("2 单异常");
    expect(within(pausedRow).getByRole("link", { name: "查看 暂停合作客户 详情" })).toHaveAttribute(
      "href",
      "/admin/customers/customer-2",
    );
    const mobileCards = document.querySelector("[data-customer-cards]");
    expect(mobileCards).not.toBeNull();
    const pausedCard = within(mobileCards as HTMLElement).getByRole("link", {
      name: "查看 暂停合作客户 详情",
    });
    expect(pausedCard).toHaveTextContent("paused-owner@test.local");
    expect(pausedCard).toHaveTextContent("1 家");
    expect(pausedCard).toHaveTextContent("¥987.00");
    expect(pausedCard).toHaveTextContent("¥123.00");
    expect(pausedCard).toHaveTextContent("3 单");
    expect(pausedCard).toHaveTextContent("2 单异常");

    fireEvent.click(screen.getByRole("button", { name: "新建客户" }));
    const drawer = await screen.findByRole("dialog", { name: "新建客户" });
    for (const field of ["客户编号", "客户名称", "店铺名称", "登录邮箱", "初始密码", "创建原因"]) {
      expect(within(drawer).getByLabelText(field)).toBeVisible();
    }
    expect(within(drawer).getByRole("button", { name: "创建客户与店铺" })).toBeEnabled();
  });

  it("shows actionable initial and filtered empty states", async () => {
    detailQueryMocks.listCustomerManagementRows.mockResolvedValue([]);

    const { unmount } = render(await CustomersPage());

    const initialState = screen.getByRole("status", { name: "暂无客户" });
    expect(initialState).toHaveAttribute("data-kind", "initial");
    expect(within(initialState).getByRole("button", { name: "新建第一位客户" })).toBeEnabled();

    unmount();
    detailQueryMocks.listCustomerManagementRows.mockResolvedValue([
      {
        accountDisplayName: "北区负责人",
        accountEmail: "north-owner@test.local",
        accountStatus: "ACTIVE",
        balanceFen: 123_456,
        code: "NORTH-01",
        contactName: "李青",
        customerId: "customer-1",
        exceptionOrderCount: 0,
        name: "华北客户",
        pendingPaymentFen: 2_500,
        recentOrderCount: 8,
        status: "ACTIVE",
        storeCount: 2,
      },
    ]);

    render(await CustomersPage());
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索客户" }), {
      target: { value: "不存在的客户" },
    });

    const filteredState = screen.getByRole("status", { name: "没有符合条件的客户" });
    expect(filteredState).toHaveAttribute("data-kind", "filtered");
    expect(within(filteredState).getByRole("button", { name: "清除筛选" })).toBeEnabled();
  });

  it("renders desktop store editing and mobile collapsed store cards on the detail page", async () => {
    detailQueryMocks.getCustomerManagementDetail.mockResolvedValue({
      account: {
        displayName: "北区负责人",
        email: "north-owner@test.local",
        status: "ACTIVE",
      },
      customer: {
        code: "NORTH-01",
        contactName: "李青",
        contactWechat: "liqing-ops",
        id: "customer-1",
        name: "华北客户",
        status: "ACTIVE",
      },
      stores: [
        {
          customerId: "customer-1",
          externalStoreCode: "TEMU-NORTH-001",
          id: "store-1",
          name: "华北一店",
          platform: "TEMU",
          status: "ACTIVE",
        },
        {
          customerId: "customer-1",
          externalStoreCode: "TEMU-NORTH-002",
          id: "store-2",
          name: "华北二店",
          platform: "TEMU",
          status: "DISABLED",
        },
      ],
    });

    render(
      await CustomerDetailPage({
        params: Promise.resolve({ customerId: "customer-1" }),
      }),
    );

    expect(screen.getByRole("heading", { name: "客户详情" })).toBeVisible();
    expect(screen.getByDisplayValue("华北客户")).toBeVisible();
    expect(screen.getByDisplayValue("north-owner@test.local")).toBeVisible();
    expect(screen.getByText("唯一客户账号")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存客户资料" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新增店铺" })).toBeEnabled();

    const desktopSummaryRow = screen.getAllByRole("row", { name: /华北二店.*已停用/ })[0];
    expect(within(desktopSummaryRow).getByText("已停用")).toBeVisible();

    const storeCard = screen
      .getAllByText("华北二店")
      .map((node) => node.closest("details"))
      .find((node): node is HTMLDetailsElement => node instanceof HTMLDetailsElement);
    expect(storeCard).not.toBeNull();

    const storeCardScope = within(storeCard as HTMLDetailsElement);
    expect(storeCardScope.getByText("编辑店铺")).toBeVisible();
    expect(
      storeCardScope.getByText(/已停用后新拿货已关闭，历史数据.*保留。/),
    ).toBeVisible();
    expect(storeCardScope.getByDisplayValue("华北二店")).not.toBeVisible();

    (storeCard as HTMLDetailsElement).open = true;

    expect(storeCardScope.getByDisplayValue("华北二店")).toBeVisible();
    expect(storeCardScope.getByRole("button", { name: "保存店铺资料" })).toBeEnabled();
    expect(storeCardScope.getByRole("button", { name: "恢复店铺" })).toBeEnabled();
  });
});
