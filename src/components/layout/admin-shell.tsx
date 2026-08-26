"use client";

import {
  Activity,
  Banknote,
  BarChart3,
  BellRing,
  Boxes,
  Building2,
  ClipboardList,
  History,
  LayoutDashboard,
  PackageSearch,
  PlugZap,
  RotateCcw,
  Settings2,
  WalletCards,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { AuthenticatedIdentity } from "@/modules/identity/principal";
import { INVENTORY_MOVEMENTS_PATH } from "@/modules/inventory/movement-navigation";

import { MerchantShellFrame } from "./merchant-shell-frame";
import { MerchantTopbar } from "./merchant-topbar";
import { MobileTaskDock } from "./mobile-task-dock";
import { NavigationSection, type NavigationItem } from "./navigation-section";

type AdminPrincipalKind = "ADMIN" | "SUPER_ADMIN";

type AdminNavigationGroup = {
  id: string;
  label?: string;
  items: NavigationItem[];
};

function navigationForRole(principalKind: AdminPrincipalKind): AdminNavigationGroup[] {
  return [
    {
      id: "admin-overview",
      items: [{ href: "/admin", icon: LayoutDashboard, label: "运营总览", exact: true }],
    },
    {
      id: "admin-customers-products",
      label: "客户与货品",
      items: [
        { href: "/admin/customers", icon: Building2, label: "客户与店铺" },
        { href: "/admin/catalog", icon: PackageSearch, label: "商品与 SKU" },
        { href: "/admin/inventory", icon: Boxes, label: "实时库存", exact: true },
        { href: INVENTORY_MOVEMENTS_PATH, icon: History, label: "库存流水" },
      ],
    },
    {
      id: "admin-order-fulfillment",
      label: "订单履约",
      items: [
        { href: "/admin/orders", icon: ClipboardList, label: "订单管理" },
        { href: "/admin/replacements", icon: RotateCcw, label: "补发管理" },
      ],
    },
    {
      id: "admin-funds-data",
      label: "资金与数据",
      items: [
        { href: "/admin/settlement", icon: Banknote, label: "收款审核" },
        { href: "/admin/wallets", icon: WalletCards, label: "客户余额" },
        { href: "/admin/settlement-batches", icon: WalletCards, label: "合并付款审核" },
        { href: "/admin/reports", icon: BarChart3, label: "报表分析" },
      ],
    },
    {
      id: "admin-system",
      label: "系统管理",
      items: [
        ...(principalKind === "SUPER_ADMIN"
          ? [{ href: "/admin/accounts", icon: Settings2, label: "账号管理" } satisfies NavigationItem]
          : []),
        { href: "/admin/notifications", icon: BellRing, label: "系统通知" },
        { href: "/admin/system/integrations", icon: PlugZap, label: "外部集成" },
        { href: "/admin/system/health", icon: Activity, label: "系统健康" },
        { href: "/admin/system/audit", icon: Settings2, label: "审计日志" },
      ],
    },
  ];
}

function AdminNavigation({
  mobile = false,
  principalKind,
}: {
  mobile?: boolean;
  principalKind: AdminPrincipalKind;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="管理员主导航" className="space-y-2 px-3 py-3">
      {navigationForRole(principalKind).map((group) => (
        <NavigationSection
          activePath={pathname}
          audience="admin"
          id={group.id}
          items={group.items}
          key={group.id}
          label={group.label}
          mobile={mobile}
        />
      ))}
    </nav>
  );
}

export function AdminShell({
  children,
  identity,
  principalKind,
}: {
  children: ReactNode;
  identity: AuthenticatedIdentity;
  principalKind: AdminPrincipalKind;
}) {
  const roleLabel = principalKind === "SUPER_ADMIN" ? "超级管理员" : "普通管理员";

  return (
    <MerchantShellFrame
      audience="admin"
      mobileDock={
        <MobileTaskDock
          ariaLabel="管理员快捷导航"
          items={[
            { exact: true, href: "/admin", icon: LayoutDashboard, label: "总览" },
            { href: "/admin/orders", icon: ClipboardList, label: "订单" },
            { href: "/admin/settlement", icon: Banknote, label: "收款" },
            { href: "/admin/notifications", icon: BellRing, label: "通知" },
          ]}
        />
      }
      navigation={<AdminNavigation principalKind={principalKind} />}
      topbar={
        <MerchantTopbar
          audience="admin"
          identity={identity}
          mobileNavigation={<AdminNavigation mobile principalKind={principalKind} />}
          mobileNavigationTitle="管理员导航"
          roleLabel={roleLabel}
          subtitle="加拿大本地货盘 · TEMU 一件代发"
          title="同舟行运营中心"
        />
      }
    >
      {children}
    </MerchantShellFrame>
  );
}
