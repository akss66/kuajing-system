// @vitest-environment jsdom
/* eslint-disable @next/next/no-img-element */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      <AdminShell principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    expect(screen.getByTestId("merchant-shell")).toHaveAttribute("data-shell-version", "v2");
    expect(screen.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "admin");
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
    fireEvent.click(within(navigation).getByRole("button", { name: "系统管理" }));
    expect(within(navigation).getByRole("link", { name: "账号管理" })).toBeVisible();
    fireEvent.pointerDown(screen.getByRole("button", { name: "打开账号菜单" }));
    expect(screen.getByRole("button", { name: "退出登录" })).toBeVisible();
    expect(screen.getByText("内容")).toBeVisible();
  });

  it("keeps ordinary admin navigation without the super-admin account entry", () => {
    render(
      <AdminShell principalKind="ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
    fireEvent.click(within(navigation).getByRole("button", { name: "系统管理" }));
    expect(within(navigation).queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
  });

  it("persists navigation section collapse state in the current browser", async () => {
    const firstRender = render(
      <AdminShell principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const firstNavigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    const ordersSection = within(firstNavigation).getByRole("button", { name: "订单履约" });
    expect(ordersSection).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(ordersSection);
    expect(ordersSection).toHaveAttribute("aria-expanded", "false");

    firstRender.unmount();
    render(
      <AdminShell principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const secondNavigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    await waitFor(() =>
      expect(within(secondNavigation).getByRole("button", { name: "订单履约" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
  });

  it("automatically opens the collapsed group containing the current route", async () => {
    window.localStorage.setItem("merchant-navigation-section:admin-system", "false");
    navigationState.pathname = "/admin/system/health";

    render(
      <AdminShell principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    await waitFor(() =>
      expect(within(navigation).getByRole("button", { name: "系统管理" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    expect(within(navigation).getByRole("link", { name: "系统健康" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the mobile account menu compact without leaking admin-only navigation into the customer shell", () => {
    navigationState.pathname = "/portal";

    render(
      <CustomerShell>
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
    expect(screen.getByRole("button", { name: "退出登录" })).toBeVisible();
    expect(within(navigation).queryByRole("link", { name: "运营总览" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
    expect(screen.getByText("客户内容")).toBeVisible();
  });
});
