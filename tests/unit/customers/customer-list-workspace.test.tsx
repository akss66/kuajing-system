// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomerManagementListRow } from "@/modules/customers/queries";

vi.mock("@/modules/customers/actions", () => ({
  createCustomerWithStoreAction: vi.fn(),
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

import { CustomerListWorkspace } from "@/components/customers/customer-list-workspace";

const rows: CustomerManagementListRow[] = [
  {
    accountDisplayName: "零店负责人",
    accountEmail: "zero@test.local",
    accountStatus: "ACTIVE",
    balanceFen: 10_000,
    code: "ZERO",
    contactName: null,
    customerId: "customer-zero",
    exceptionOrderCount: 0,
    name: "零店启用客户",
    pendingPaymentFen: 0,
    recentOrderCount: 1,
    status: "ACTIVE",
    storeCount: 0,
  },
  {
    accountDisplayName: "单店负责人",
    accountEmail: "one@test.local",
    accountStatus: "DISABLED",
    balanceFen: 20_000,
    code: "ONE",
    contactName: null,
    customerId: "customer-one",
    exceptionOrderCount: 2,
    name: "单店停用客户",
    pendingPaymentFen: 500,
    recentOrderCount: 2,
    status: "DISABLED",
    storeCount: 1,
  },
  {
    accountDisplayName: null,
    accountEmail: null,
    accountStatus: null,
    balanceFen: 30_000,
    code: "MULTIPLE",
    contactName: null,
    customerId: "customer-multiple",
    exceptionOrderCount: 0,
    name: "多店待同步客户",
    pendingPaymentFen: 0,
    recentOrderCount: 3,
    status: "ACTIVE",
    storeCount: 3,
  },
];

afterEach(() => {
  cleanup();
});

function expectOnlyDesktopRow(customerName: string) {
  const table = screen.getByRole("table", { name: "客户列表" });
  expect(within(table).getByRole("row", { name: new RegExp(customerName) })).toBeVisible();
  for (const other of rows.filter((row) => row.name !== customerName)) {
    expect(within(table).queryByRole("row", { name: new RegExp(other.name) })).not.toBeInTheDocument();
  }
}

async function selectAdvancedFilter(label: string, value: string) {
  fireEvent.click(screen.getByRole("button", { name: "更多筛选" }));
  const drawer = await screen.findByRole("dialog", { name: "更多筛选" });
  fireEvent.change(within(drawer).getByRole("combobox", { name: label }), {
    target: { value },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(drawer).not.toBeInTheDocument());
}

describe("CustomerListWorkspace filters", () => {
  it("filters customer rows by customer status", () => {
    render(<CustomerListWorkspace rows={rows} />);

    fireEvent.change(screen.getByRole("combobox", { name: "客户状态筛选" }), {
      target: { value: "DISABLED" },
    });

    expectOnlyDesktopRow("单店停用客户");
  });

  it("filters customer rows by store-count bucket", () => {
    render(<CustomerListWorkspace rows={rows} />);

    fireEvent.change(screen.getByRole("combobox", { name: "店铺数筛选" }), {
      target: { value: "MULTIPLE" },
    });

    expectOnlyDesktopRow("多店待同步客户");
  });

  it("filters customer rows by account mirror status", async () => {
    render(<CustomerListWorkspace rows={rows} />);

    await selectAdvancedFilter("账号状态", "MISSING");

    expectOnlyDesktopRow("多店待同步客户");
  });

  it("filters customer rows by fulfillment exceptions", async () => {
    render(<CustomerListWorkspace rows={rows} />);

    await selectAdvancedFilter("异常订单", "WITH");

    expectOnlyDesktopRow("单店停用客户");
  });
});
