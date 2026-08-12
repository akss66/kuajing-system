// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
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

describe("AccountsPage", () => {
  beforeEach(() => {
    guardMocks.requireAdmin.mockReset();
    queryMocks.listManagedAccounts.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows segmented account management for the super admin and protects the bootstrap super admin row", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    queryMocks.listManagedAccounts.mockResolvedValue([
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
    ]);

    render(await AccountsPage());

    expect(screen.getByRole("heading", { name: "账号管理" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "管理员账号" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "客户账号" })).toBeVisible();
    expect(screen.getByLabelText("管理员姓名")).toBeRequired();
    expect(screen.getByLabelText("登录邮箱")).toHaveAttribute("type", "email");
    expect(screen.getByRole("button", { name: "创建管理员账号" })).toBeEnabled();

    const protectedRow = screen.getByRole("row", { name: /Bootstrap Super Admin/ });
    expect(within(protectedRow).getByText("受保护超级管理员")).toBeVisible();
    expect(
      within(protectedRow).queryByRole("button", { name: "停用账号" }),
    ).not.toBeInTheDocument();
    expect(
      within(protectedRow).queryByRole("button", { name: "重置密码" }),
    ).not.toBeInTheDocument();

    expect(screen.getAllByText("客户账号").length).toBeGreaterThan(0);
    const storeCountMetric = document.querySelectorAll("[data-workspace-panel]")[3];
    expect(storeCountMetric).toBeInstanceOf(HTMLElement);
    expect(within(storeCountMetric as HTMLElement).getByText("3")).toBeVisible();
    expect(screen.queryByText("SUPER_ADMIN")).not.toBeInTheDocument();
    expect(screen.queryByText("CUSTOMER")).not.toBeInTheDocument();
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
});
