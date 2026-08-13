"use client";

import {
  Activity,
  Banknote,
  BarChart3,
  BellRing,
  Boxes,
  Building2,
  ClipboardList,
  FileSearch,
  LayoutDashboard,
  PackageSearch,
  PlugZap,
  RotateCcw,
  Settings2,
  WalletCards,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { MerchantShellFrame } from "./merchant-shell-frame";
import { MerchantTopbar } from "./merchant-topbar";
import { NavigationSection, type NavigationItem } from "./navigation-section";

type AdminPrincipalKind = "ADMIN" | "SUPER_ADMIN";

type AdminNavigationGroup = {
  id: string;
  label: string;
  defaultOpen: boolean;
  items: NavigationItem[];
};

function navigationForRole(principalKind: AdminPrincipalKind): AdminNavigationGroup[] {
  return [
    {
      id: "admin-workbench",
      label: "工作台",
      defaultOpen: true,
      items: [{ href: "/admin", icon: LayoutDashboard, label: "运营总览", exact: true }],
    },
    {
      id: "admin-customers-products",
      label: "客户与货品",
      defaultOpen: true,
      items: [
        { href: "/admin/customers", icon: Building2, label: "客户与店铺" },
        { href: "/admin/catalog", icon: PackageSearch, label: "商品与 SKU" },
        { href: "/admin/inventory", icon: Boxes, label: "货盘库存" },
      ],
    },
    {
      id: "admin-order-fulfillment",
      label: "订单履约",
      defaultOpen: true,
      items: [
        { href: "/admin/orders", icon: ClipboardList, label: "订单管理" },
        { href: "/admin/bulk-orders", icon: FileSearch, label: "批量草稿诊断" },
        { href: "/admin/replacements", icon: RotateCcw, label: "补发管理" },
      ],
    },
    {
      id: "admin-funds-data",
      label: "资金与数据",
      defaultOpen: true,
      items: [
        { href: "/admin/settlement", icon: Banknote, label: "收款与余额" },
        { href: "/admin/settlement-batches", icon: WalletCards, label: "统一结算批次" },
        { href: "/admin/reports", icon: BarChart3, label: "报表分析" },
      ],
    },
    {
      id: "admin-system",
      label: "系统管理",
      defaultOpen: false,
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
          defaultOpen={group.defaultOpen}
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
  principalKind,
}: {
  children: ReactNode;
  principalKind: AdminPrincipalKind;
}) {
  const badgeLabel = principalKind === "SUPER_ADMIN" ? "超级管理员" : "普通管理员";

  return (
    <MerchantShellFrame
      audience="admin"
      navigation={<AdminNavigation principalKind={principalKind} />}
      topbar={
        <MerchantTopbar
          audience="admin"
          badgeLabel={badgeLabel}
          mobileNavigation={<AdminNavigation mobile principalKind={principalKind} />}
          mobileNavigationTitle="管理员导航"
          subtitle="加拿大本地货盘 · TEMU 一件代发"
          title="同舟行运营中心"
        />
      }
    >
      {children}
    </MerchantShellFrame>
  );
}
