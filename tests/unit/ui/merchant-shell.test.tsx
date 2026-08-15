// @vitest-environment jsdom
/* eslint-disable @next/next/no-img-element */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationState = vi.hoisted(() => ({
  pathname: "/admin",
  searchParams: "",
}));

vi.mock("next/image", () => ({
  default: ({
    alt,
    priority: _priority,
    src,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    priority?: boolean;
    src: string;
  }) => {
    void _priority;
    return <img alt={alt} src={src} {...props} />;
  },
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useSearchParams: () => new URLSearchParams(navigationState.searchParams),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

import { AdminShell } from "@/components/layout/admin-shell";
import { CustomerShell } from "@/components/layout/customer-shell";

const adminIdentity = {
  displayName: "本地演示管理员",
  email: "admin@tongzhouxing.local",
};

const customerIdentity = {
  displayName: "渥太华演示客户",
  email: "customer@tongzhouxing.local",
};

describe("merchant shells", () => {
  beforeEach(() => {
    navigationState.pathname = "/admin";
    navigationState.searchParams = "";
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the admin merchant shell with the shared topbar and role-aware navigation", () => {
    render(
      <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    expect(screen.getByTestId("merchant-shell")).toHaveAttribute("data-shell-version", "v2");
    expect(screen.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "admin");
    const brand = document.querySelector<HTMLElement>("[data-merchant-brand]");
    const sidebar = document.querySelector<HTMLElement>("[data-merchant-sidebar]");
    const topbar = screen.getByRole("banner");

    expect(brand).not.toHaveClass("border-r", "border-white/12");
    expect(sidebar).toHaveClass("border-r", "border-border");
    expect(topbar).toHaveClass("border-b");
    expect(brand).toHaveClass("w-[var(--merchant-sidebar-width)]");
    expect(screen.getByText("客户与货品")).toBeVisible();
    expect(screen.getByText("订单履约")).toBeVisible();
    expect(screen.getByText("资金与数据")).toBeVisible();
    expect(screen.getByText("系统管理")).toBeVisible();
    expect(screen.queryByRole("button", { name: "帮助" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "消息" })).not.toBeInTheDocument();
    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "客户与店铺" })).toBeVisible();
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(within(navigation).getByRole("link", { name: "账号管理" })).toBeVisible();
    fireEvent.pointerDown(screen.getByRole("button", { name: "打开账号菜单" }));
    const accountMenu = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
    expect(accountMenu).not.toBeNull();
    expect(within(accountMenu!).getByText(adminIdentity.displayName, { exact: true })).toBeVisible();
    expect(within(accountMenu!).getByText(adminIdentity.email, { exact: true })).toBeVisible();
    expect(within(accountMenu!).getByText("超级管理员", { exact: true })).toBeVisible();
    expect(within(accountMenu!).queryByText("管理员账号", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
    expect(screen.getByText("内容")).toBeVisible();
  });

  it("keeps ordinary admin navigation without the super-admin account entry", () => {
    const namelessIdentity = {
      displayName: null,
      email: "nameless-admin@test.local",
    };
    render(
      <AdminShell identity={namelessIdentity} principalKind="ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
    expect(within(navigation).queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "打开账号菜单" }));
    const accountMenu = document.querySelector<HTMLElement>("[data-slot='dropdown-menu-content']");
    expect(accountMenu).not.toBeNull();
    expect(within(accountMenu!).getByText("未设置姓名", { exact: true })).toBeVisible();
    expect(within(accountMenu!).getByText(namelessIdentity.email, { exact: true })).toBeVisible();
    expect(within(accountMenu!).getByText("普通管理员", { exact: true })).toBeVisible();
  });

  it("renders static navigation labels with every route visible and no collapse state", () => {
    render(
      <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    for (const label of ["客户与货品", "订单履约", "资金与数据", "系统管理"]) {
      expect(within(navigation).getByRole("heading", { level: 2, name: label })).toBeVisible();
      expect(within(navigation).queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(within(navigation).queryByText("工作台")).not.toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "系统健康" })).toBeVisible();
    expect(navigation.querySelector("[aria-expanded]")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("marks the current route with aria-current and a non-color active rail", () => {
    navigationState.pathname = "/admin/system/health";

    render(
      <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    const current = within(navigation).getByRole("link", { name: "系统健康" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveClass("before:w-0.5", "before:bg-[var(--merchant-nav-active-foreground)]");
  });

  it("keeps the mobile account menu compact without leaking admin-only navigation into the customer shell", () => {
    navigationState.pathname = "/portal";

    render(
      <CustomerShell identity={customerIdentity}>
        <div>客户内容</div>
      </CustomerShell>,
    );

    expect(screen.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "customer");
    const navigation = screen.getAllByRole("navigation", { name: "客户主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "客户首页" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "多店铺批量拿货" })).toBeVisible();
    expect(screen.getByText("拿货")).toBeVisible();
    expect(screen.getByText("订单与付款")).toBeVisible();
    expect(screen.queryByText("店铺数据")).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);

    fireEvent.pointerDown(screen.getByRole("button", { name: "打开账号菜单" }));

    const accountMenu = document.querySelector("[data-slot='dropdown-menu-content']");
    expect(accountMenu).toHaveClass("w-[236px]", "p-1.5", "sm:w-64", "sm:p-2");
    expect(
      within(accountMenu as HTMLElement).getByText(customerIdentity.displayName, { exact: true }),
    ).toBeVisible();
    expect(
      within(accountMenu as HTMLElement).getByText(customerIdentity.email, { exact: true }),
    ).toBeVisible();
    expect(within(accountMenu as HTMLElement).getByText("合作客户", { exact: true })).toBeVisible();
    expect(
      within(accountMenu as HTMLElement).queryByText("客户账号", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
    expect(within(navigation).queryByRole("link", { name: "运营总览" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
    expect(screen.getByText("客户内容")).toBeVisible();
  });
});
