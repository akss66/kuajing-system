// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  listManagedAccounts: vi.fn(),
}));

vi.mock("@/modules/accounts/actions", () => ({
  createAdminAccountAction: vi.fn(),
  resetManagedAccountPasswordAction: vi.fn(),
  setManagedAccountStatusAction: vi.fn(),
  updateManagedAccountAction: vi.fn(),
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

vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/accounts/queries", () => queryMocks);

import AccountsPage from "@/app/(admin)/admin/accounts/page";

const customerId = "11111111-1111-4111-8111-111111111111";

const accountsFixture = [
  {
    customerId: null,
    customerName: null,
    displayName: "Bootstrap Super Admin",
    email: "super-admin@test.local",
    kind: "SUPER_ADMIN",
    lastLoginAt: "2026-08-12T08:15:00.000Z",
    status: "ACTIVE",
    storeCount: 0,
    userId: "super-admin-auth-user",
  },
  {
    customerId: null,
    customerName: null,
    displayName: "Operations Admin",
    email: "ops-admin@test.local",
    kind: "ADMIN",
    lastLoginAt: null,
    status: "ACTIVE",
    storeCount: 0,
    userId: "admin-user-1",
  },
  {
    customerId,
    customerName: "华北客户",
    displayName: "Customer Owner",
    email: "customer-owner@test.local",
    kind: "CUSTOMER",
    lastLoginAt: "2026-08-11T19:20:00.000Z",
    status: "DISABLED",
    storeCount: 3,
    userId: "customer-user-1",
  },
] as const;

function accountDetailTrigger(displayName: string) {
  return screen.getAllByRole("button", { name: `查看 ${displayName}` })[0];
}

async function findAccountDetailTrigger(displayName: string) {
  return (await screen.findAllByRole("button", { name: `查看 ${displayName}` }))[0];
}

function queryAccountDetailTriggers(displayName: string) {
  return screen.queryAllByRole("button", { name: `查看 ${displayName}` });
}

describe("AccountsPage", () => {
  beforeEach(() => {
    guardMocks.requireAdmin.mockReset();
    queryMocks.listManagedAccounts.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps account forms out of the compact workspace until their drawer is opened", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(await AccountsPage());

    expect(screen.getByRole("heading", { name: "账号管理" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新建管理员" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "管理员账号 2" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "客户账号 1" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "已停用 1" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "搜索账号" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "角色筛选" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "状态筛选" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("管理员姓名")).not.toBeInTheDocument();

    fireEvent.click(accountDetailTrigger("Operations Admin"));

    const dialog = await screen.findByRole("dialog", { name: "Operations Admin" });
    expect(within(dialog).getByRole("region", { name: "基本资料" })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "登录安全" })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "危险操作" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "保存资料" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "重置密码" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "停用账号" })).toBeVisible();
    expect(screen.queryByText("SUPER_ADMIN")).not.toBeInTheDocument();
    expect(screen.queryByText("CUSTOMER")).not.toBeInTheDocument();
  });

  it("filters account summaries by searchable identity, role, and status", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(await AccountsPage());

    const search = screen.getByRole("searchbox", { name: "搜索账号" });
    fireEvent.change(search, { target: { value: "ops-admin@test.local" } });
    expect(accountDetailTrigger("Operations Admin")).toBeVisible();
    expect(queryAccountDetailTriggers("Bootstrap Super Admin")).toHaveLength(0);

    fireEvent.change(screen.getByRole("combobox", { name: "角色筛选" }), {
      target: { value: "SUPER_ADMIN" },
    });
    expect(screen.getByText("没有符合条件的账号")).toBeVisible();

    fireEvent.change(search, { target: { value: "华北客户" } });
    fireEvent.change(screen.getByRole("combobox", { name: "角色筛选" }), {
      target: { value: "ALL" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "状态筛选" }), {
      target: { value: "DISABLED" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "客户账号 1" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await findAccountDetailTrigger("Customer Owner")).toBeVisible();
  });

  it("scopes a customer-detail deep link to the matching customer account with a removable filter", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(
      await AccountsPage({
        searchParams: Promise.resolve({ customerId }),
      }),
    );

    expect(screen.getByRole("tab", { name: "客户账号 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const activeFilters = screen.getByLabelText("已启用筛选");
    expect(within(activeFilters).getByText("客户：华北客户", { exact: true })).toBeVisible();
    expect(
      within(activeFilters).getByRole("link", { name: "移除筛选：客户 华北客户" }),
    ).toHaveAttribute("href", "/admin/accounts");
    expect(accountDetailTrigger("Customer Owner")).toBeVisible();
    expect(queryAccountDetailTriggers("Bootstrap Super Admin")).toHaveLength(0);
    expect(queryAccountDetailTriggers("Operations Admin")).toHaveLength(0);
  });

  it("ignores an ambiguous customerId query instead of applying an unsafe partial match", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(
      await AccountsPage({
        searchParams: Promise.resolve({ customerId: ["customer-1", "customer-2"] }),
      }),
    );

    expect(screen.queryByLabelText("已启用筛选")).not.toBeInTheDocument();
    expect(accountDetailTrigger("Bootstrap Super Admin")).toBeVisible();
    expect(accountDetailTrigger("Operations Admin")).toBeVisible();
  });

  it("keeps a valid but unmatched customerId scoped to an empty result until the filter is removed", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);
    const unmatchedCustomerId = "22222222-2222-4222-8222-222222222222";

    render(
      await AccountsPage({
        searchParams: Promise.resolve({ customerId: unmatchedCustomerId }),
      }),
    );

    expect(screen.getByRole("tab", { name: "客户账号 0" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const activeFilters = screen.getByLabelText("已启用筛选");
    expect(within(activeFilters).getByText("指定客户", { exact: true })).toBeVisible();
    expect(screen.getByText("没有符合条件的账号")).toBeVisible();
    expect(queryAccountDetailTriggers("Bootstrap Super Admin")).toHaveLength(0);
    expect(queryAccountDetailTriggers("Operations Admin")).toHaveLength(0);
  });

  it("ignores a malformed customerId query and preserves the normal full account view", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(
      await AccountsPage({
        searchParams: Promise.resolve({ customerId: "not-a-customer-id" }),
      }),
    );

    expect(screen.queryByLabelText("已启用筛选")).not.toBeInTheDocument();
    expect(accountDetailTrigger("Bootstrap Super Admin")).toBeVisible();
    expect(accountDetailTrigger("Operations Admin")).toBeVisible();
  });

  it("renders a fixed native account table only at the desktop breakpoint", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(await AccountsPage());

    const table = screen.getByRole("table", { name: "账号列表" });
    expect(table.tagName).toBe("TABLE");
    expect(table).toHaveClass("hidden", "table-fixed", "xl:table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "姓名",
      "邮箱",
      "角色",
      "所属客户",
      "店铺数",
      "状态",
      "最近登录",
      "操作",
    ]);

    const columnGroups = table.querySelectorAll("colgroup");
    expect(columnGroups).toHaveLength(1);
    expect(columnGroups[0].querySelectorAll("col")).toHaveLength(8);
    expect(columnGroups[0].querySelector("[data-account-column='actions']")).toHaveClass("w-28");

    const operationsRow = within(table).getByRole("row", { name: /Operations Admin/ });
    expect(operationsRow).not.toHaveAttribute("data-account-card");
    const cells = within(operationsRow).getAllByRole("cell");
    expect(cells).toHaveLength(8);
    expect(cells[0]).toHaveTextContent("Operations Admin");
    expect(cells[1]).toHaveTextContent("ops-admin@test.local");
    expect(cells[2]).toHaveTextContent("普通管理员");
    expect(cells[5]).toHaveTextContent("启用中");
  });

  it("renders mobile and tablet account cards as a separate surface hidden at xl", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(await AccountsPage());

    const table = screen.getByRole("table", { name: "账号列表" });
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-account-card]"));
    expect(cards).toHaveLength(2);
    expect(cards[0].tagName).toBe("LI");
    expect(cards[0]).toHaveClass("xl:hidden");
    expect(table.contains(cards[0])).toBe(false);
    expect(within(cards[0]).getByText("Bootstrap Super Admin")).toBeVisible();
    expect(within(cards[0]).getByText("超级管理员", { exact: true })).toBeVisible();
    expect(within(cards[0]).getByText("启用中", { exact: true })).toBeVisible();
    expect(within(cards[1]).getByText("ops-admin@test.local")).toBeVisible();
  });

  it("wraps a long email anywhere without widening the action column", async () => {
    const longEmail =
      "warehouse-operations-and-customer-success-for-northern-region@accounts.test.local";
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue([
      {
        ...accountsFixture[1],
        email: longEmail,
      },
    ]);

    render(await AccountsPage());

    const table = screen.getByRole("table", { name: "账号列表" });
    const emailCell = within(table).getByText(longEmail).closest("td");
    expect(emailCell).toHaveClass("[overflow-wrap:anywhere]", "whitespace-normal");
    expect(table.querySelector("[data-account-column='actions']")).toHaveClass("w-28");
  });

  it("allows account tabs to scroll only below the desktop breakpoint", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(accountsFixture);

    render(await AccountsPage());

    expect(screen.getByRole("tablist")).toHaveClass(
      "overflow-x-auto",
      "xl:overflow-x-visible",
    );
  });

  it("keeps the bootstrap super admin protected and links customer accounts to business details", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue(
      accountsFixture.filter((account) => account.kind !== "ADMIN"),
    );

    render(await AccountsPage());

    fireEvent.click(accountDetailTrigger("Bootstrap Super Admin"));
    const protectedDialog = await screen.findByRole("dialog", { name: "Bootstrap Super Admin" });
    expect(within(protectedDialog).getByText("受保护")).toBeVisible();
    expect(within(protectedDialog).getByText(/系统初始化的超级管理员/)).toBeVisible();
    expect(within(protectedDialog).queryByRole("button", { name: "重置密码" })).not.toBeInTheDocument();
    expect(within(protectedDialog).queryByRole("button", { name: "停用账号" })).not.toBeInTheDocument();

    fireEvent.click(within(protectedDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(protectedDialog).not.toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole("tab", { name: "客户账号 1" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await findAccountDetailTrigger("Customer Owner"));

    const customerDialog = await screen.findByRole("dialog", { name: "Customer Owner" });
    expect(within(customerDialog).getByText("3 家店铺")).toBeVisible();
    expect(within(customerDialog).getByRole("link", { name: "查看客户详情" })).toHaveAttribute(
      "href",
      `/admin/customers/${customerId}`,
    );
    expect(within(customerDialog).queryByLabelText("客户名称")).not.toBeInTheDocument();
  });

  it("safely denies the route to an ordinary admin without loading governed accounts", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "ops-admin-auth-user",
    });

    render(
      await AccountsPage({
        searchParams: Promise.resolve({ customerId }),
      }),
    );

    expect(screen.getByRole("heading", { name: "账号管理受限" })).toBeVisible();
    expect(
      screen.getByText("只有超级管理员可以查看、创建或停用账号。"),
    ).toBeVisible();
    expect(queryMocks.listManagedAccounts).not.toHaveBeenCalled();
  });

  it("opens the account status confirmation dialog from the managed account row", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue([
      {
        customerId: null,
        customerName: null,
        displayName: "Operations Admin",
        email: "ops-admin@test.local",
        kind: "ADMIN",
        lastLoginAt: null,
        status: "ACTIVE",
        storeCount: 0,
        userId: "admin-user-1",
      },
    ]);

    render(await AccountsPage());

    expect(screen.queryByRole("button", { name: "停用账号" })).not.toBeInTheDocument();
    fireEvent.click(accountDetailTrigger("Operations Admin"));
    const accountDialog = await screen.findByRole("dialog", { name: "Operations Admin" });
    fireEvent.click(within(accountDialog).getByRole("button", { name: "停用账号" }));

    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认停用这个账号？")).toBeVisible();
    expect(
      screen.getByText("停用后该账号的现有会话会立即失效，但历史订单、客户关系和审计日志不会删除。"),
    ).toBeVisible();
  });

  it("keeps password reset neutral while account status confirmation remains destructive", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue([accountsFixture[1]]);

    render(await AccountsPage());

    fireEvent.click(accountDetailTrigger("Operations Admin"));
    const accountDialog = await screen.findByRole("dialog", { name: "Operations Admin" });
    const resetTrigger = within(accountDialog).getByRole("button", { name: "重置密码" });
    const statusTrigger = within(accountDialog).getByRole("button", { name: "停用账号" });

    expect(resetTrigger).toHaveAttribute("data-variant", "outline");
    expect(statusTrigger).toHaveAttribute("data-variant", "destructive");

    fireEvent.click(resetTrigger);
    const resetDialog = screen.getByRole("alertdialog");
    expect(within(resetDialog).getByRole("button", { name: "重置密码" })).toHaveAttribute(
      "data-variant",
      "outline",
    );

    fireEvent.click(within(resetDialog).getByRole("button", { name: "返回检查" }));
    await waitFor(() => expect(resetDialog).not.toBeInTheDocument());
    fireEvent.click(statusTrigger);
    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "停用账号" }),
    ).toHaveAttribute("data-variant", "destructive");
  });
});
