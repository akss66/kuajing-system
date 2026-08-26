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
    const notificationLink = within(topbar).getByRole("link", { name: "查看系统通知" });
    expect(notificationLink).toHaveAttribute("href", "/admin/notifications");
    expect(notificationLink).toHaveClass("border-0");
    const accountTrigger = within(topbar).getByRole("button", { name: "打开账号菜单" });
    expect(accountTrigger).toHaveAttribute("data-account-trigger", "true");
    expect(accountTrigger).toHaveTextContent(adminIdentity.displayName);
    expect(accountTrigger).toHaveClass("border-0");
    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "客户与店铺" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "实时库存" })).toHaveAttribute(
      "href",
      "/admin/inventory",
    );
    expect(within(navigation).getByRole("link", { name: "库存流水" })).toHaveAttribute(
      "href",
      "/admin/inventory/movements",
    );
    expect(within(navigation).getByRole("link", { name: "收款审核" })).toHaveAttribute(
      "href",
      "/admin/settlement",
    );
    expect(within(navigation).getByRole("link", { name: "客户余额" })).toHaveAttribute(
      "href",
      "/admin/wallets",
    );
    expect(within(navigation).getByRole("link", { name: "合并付款审核" })).toHaveAttribute(
      "href",
      "/admin/settlement-batches",
    );
    expect(within(navigation).queryByRole("link", { name: "批量草稿诊断" })).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(within(navigation).getByRole("link", { name: "账号管理" })).toBeVisible();
    const quickNavigation = screen.getByRole("navigation", { name: "管理员快捷导航" });
    expect(within(quickNavigation).getByRole("link", { name: "总览" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(quickNavigation).getByRole("link", { name: "订单" })).toHaveAttribute(
      "href",
      "/admin/orders",
    );
    expect(within(quickNavigation).getByRole("link", { name: "收款" })).toHaveAttribute(
      "href",
      "/admin/settlement",
    );
    expect(within(quickNavigation).getByRole("link", { name: "通知" })).toHaveAttribute(
      "href",
      "/admin/notifications",
    );
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

  it("marks only the standalone inventory movement entry current", () => {
    navigationState.pathname = "/admin/inventory/movements";

    render(
      <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
        <div>内容</div>
      </AdminShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
    expect(within(navigation).getByRole("link", { name: "库存流水" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).getByRole("link", { name: "实时库存" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);
  });

  it("keeps the mobile account menu compact without leaking admin-only navigation into the customer shell", () => {
    navigationState.pathname = "/portal";

    render(
      <CustomerShell identity={customerIdentity}>
        <div>客户内容</div>
      </CustomerShell>,
    );

    expect(screen.getByTestId("merchant-shell")).toHaveAttribute(
      "data-design-audience",
      "portal",
    );
    expect(screen.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "customer");
    expect(screen.getByRole("banner")).toHaveClass("lg:hidden");
    const desktopSidebar = document.querySelector<HTMLElement>("[data-merchant-sidebar]");
    expect(desktopSidebar).toHaveClass("top-0", "flex-col", "lg:flex");
    expect(desktopSidebar?.querySelector("[data-merchant-brand]")).toBeInTheDocument();
    expect(desktopSidebar?.querySelector("[data-customer-sidebar-account]")).toBeInTheDocument();
    const navigation = screen.getAllByRole("navigation", { name: "客户主导航" })[0];
    expect(navigation).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "客户首页" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "实时货盘" })).toHaveAttribute(
      "href",
      "/portal/catalog",
    );
    expect(within(navigation).getByRole("link", { name: "上传订单" })).toHaveAttribute(
      "href",
      "/portal/imports/new",
    );
    expect(within(navigation).getByRole("link", { name: "我的订单" })).toHaveAttribute(
      "href",
      "/portal/orders",
    );
    expect(within(navigation).getByRole("link", { name: "资金中心" })).toHaveAttribute(
      "href",
      "/portal/wallet",
    );
    expect(within(navigation).getByRole("link", { name: "个人中心" })).toHaveAttribute(
      "href",
      "/portal/profile",
    );
    expect(within(navigation).getByRole("link", { name: "关于系统" })).toHaveAttribute(
      "href",
      "/portal/about",
    );
    expect(within(navigation).queryByRole("link", { name: "多店铺批量拿货" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "待付款" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "批量付款" })).not.toBeInTheDocument();
    expect(within(navigation).getByRole("heading", { name: "拿货" })).toBeVisible();
    expect(within(navigation).getByRole("heading", { name: "履约" })).toBeVisible();
    expect(within(navigation).getByRole("heading", { name: "资金" })).toBeVisible();
    expect(within(navigation).getByRole("heading", { name: "账户" })).toBeVisible();
    expect(within(navigation).getByRole("heading", { name: "系统" })).toBeVisible();
    expect(screen.queryByText("店铺数据")).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);
    const currentCustomerRoute = within(navigation).getByRole("link", { name: "客户首页" });
    expect(currentCustomerRoute).toHaveAttribute("data-motion-state", "current");
    expect(currentCustomerRoute.querySelector("[data-navigation-icon]")).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "实时货盘" })).toHaveAttribute(
      "data-motion-state",
      "idle",
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "打开侧栏账号菜单" }));

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
      within(accountMenu as HTMLElement).getByRole("menuitem", { name: "个人中心" }),
    ).toHaveAttribute("href", "/portal/profile");
    expect(
      within(accountMenu as HTMLElement).queryByText("客户账号", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeVisible();
    expect(within(navigation).queryByRole("link", { name: "运营总览" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
    expect(screen.getByText("客户内容")).toBeVisible();
    const quickNavigation = screen.getByRole("navigation", { name: "客户快捷导航" });
    expect(within(quickNavigation).getByRole("link", { name: "首页" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(quickNavigation).getByRole("link", { name: "上传" })).toHaveAttribute(
      "href",
      "/portal/imports/new",
    );
    expect(within(quickNavigation).getByRole("link", { name: "订单" })).toHaveAttribute(
      "href",
      "/portal/orders",
    );
    expect(within(quickNavigation).getByRole("link", { name: "资金" })).toHaveAttribute(
      "href",
      "/portal/wallet",
    );
  });

  it("keeps the advanced multi-store flow under the upload navigation task", () => {
    navigationState.pathname = "/portal/bulk-orders/draft-1";

    render(
      <CustomerShell identity={customerIdentity}>
        <div>多店铺上传内容</div>
      </CustomerShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "客户主导航" })[0];
    expect(within(navigation).getByRole("link", { name: "上传订单" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const quickNavigation = screen.getByRole("navigation", { name: "客户快捷导航" });
    expect(within(quickNavigation).getByRole("link", { name: "上传" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks personal center as the current customer location", () => {
    navigationState.pathname = "/portal/profile";

    render(
      <CustomerShell identity={customerIdentity}>
        <div>个人中心内容</div>
      </CustomerShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "客户主导航" })[0];
    expect(within(navigation).getByRole("link", { name: "个人中心" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks about system as the current customer location", () => {
    navigationState.pathname = "/portal/about";

    render(
      <CustomerShell identity={customerIdentity}>
        <div>关于系统内容</div>
      </CustomerShell>,
    );

    const navigation = screen.getAllByRole("navigation", { name: "客户主导航" })[0];
    expect(within(navigation).getByRole("link", { name: "关于系统" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.querySelector("[data-portal-content-width]")).toHaveAttribute(
      "data-portal-content-width",
      "standard",
    );
  });

  it("gives browsing, overview, and focused customer tasks intentional workspace widths", () => {
    navigationState.pathname = "/portal/catalog";

    const { rerender } = render(
      <CustomerShell identity={customerIdentity}>
        <div>实时货盘内容</div>
      </CustomerShell>,
    );

    const catalogSurface = document.querySelector<HTMLElement>("[data-portal-content-width]");
    expect(catalogSurface).toHaveAttribute("data-portal-content-width", "wide");
    expect(catalogSurface).toHaveClass("max-w-[1560px]");

    navigationState.pathname = "/portal";
    rerender(
      <CustomerShell identity={customerIdentity}>
        <div>客户首页内容</div>
      </CustomerShell>,
    );

    const standardSurface = document.querySelector<HTMLElement>("[data-portal-content-width]");
    expect(standardSurface).toHaveAttribute("data-portal-content-width", "standard");
    expect(standardSurface).toHaveClass("max-w-[1360px]");

    navigationState.pathname = "/portal/wallet";
    rerender(
      <CustomerShell identity={customerIdentity}>
        <div>资金中心内容</div>
      </CustomerShell>,
    );
    expect(document.querySelector("[data-portal-content-width]")).toHaveAttribute(
      "data-portal-content-width",
      "standard",
    );

    navigationState.pathname = "/portal/orders";
    rerender(
      <CustomerShell identity={customerIdentity}>
        <div>订单内容</div>
      </CustomerShell>,
    );

    const focusedSurface = document.querySelector<HTMLElement>("[data-portal-content-width]");
    expect(focusedSurface).toHaveAttribute("data-portal-content-width", "focused");
    expect(focusedSurface).toHaveClass("max-w-5xl");
  });
});
