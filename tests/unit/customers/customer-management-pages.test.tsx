// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("shows customer account status, store counts, and a discoverable details entry on the list page", async () => {
    detailQueryMocks.listCustomerManagementRows.mockResolvedValue([
      {
        accountDisplayName: "北区负责人",
        accountStatus: "ACTIVE",
        code: "NORTH-01",
        contactName: "李青",
        customerId: "customer-1",
        name: "华北客户",
        status: "ACTIVE",
        storeCount: 2,
      },
      {
        accountDisplayName: "暂停账号",
        accountStatus: "DISABLED",
        code: "PAUSE-02",
        contactName: null,
        customerId: "customer-2",
        name: "暂停合作客户",
        status: "DISABLED",
        storeCount: 1,
      },
    ]);

    render(await CustomersPage());

    expect(screen.getByRole("heading", { name: "客户与店铺" })).toBeVisible();
    expect(screen.getByText("账号状态")).toBeVisible();
    expect(screen.getByText("店铺数")).toBeVisible();

    const pausedRow = screen.getByRole("row", { name: /暂停合作客户/ });
    expect(within(pausedRow).getByText("账号已停用")).toBeVisible();
    expect(within(pausedRow).getByText("1 家店铺")).toBeVisible();
    expect(within(pausedRow).getByRole("link", { name: "查看详情" })).toHaveAttribute(
      "href",
      "/admin/customers/customer-2",
    );
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
