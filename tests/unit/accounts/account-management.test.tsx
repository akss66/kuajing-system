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
    customerId: "customer-1",
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

    fireEvent.click(screen.getByRole("button", { name: "查看 Operations Admin" }));

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
    expect(screen.getByRole("button", { name: "查看 Operations Admin" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 Bootstrap Super Admin" })).not.toBeInTheDocument();

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
    expect(await screen.findByRole("button", { name: "查看 Customer Owner" })).toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: "查看 Bootstrap Super Admin" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "查看 Customer Owner" }));

    const customerDialog = await screen.findByRole("dialog", { name: "Customer Owner" });
    expect(within(customerDialog).getByText("3 家店铺")).toBeVisible();
    expect(within(customerDialog).getByRole("link", { name: "查看客户详情" })).toHaveAttribute(
      "href",
      "/admin/customers/customer-1",
    );
    expect(within(customerDialog).queryByLabelText("客户名称")).not.toBeInTheDocument();
  });

  it("safely denies the route to an ordinary admin without loading governed accounts", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "ops-admin-auth-user",
    });

    render(await AccountsPage());

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
    fireEvent.click(screen.getByRole("button", { name: "查看 Operations Admin" }));
    const accountDialog = await screen.findByRole("dialog", { name: "Operations Admin" });
    fireEvent.click(within(accountDialog).getByRole("button", { name: "停用账号" }));

    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认停用这个账号？")).toBeVisible();
    expect(
      screen.getByText("停用后该账号的现有会话会立即失效，但历史订单、客户关系和审计日志不会删除。"),
    ).toBeVisible();
  });
});
