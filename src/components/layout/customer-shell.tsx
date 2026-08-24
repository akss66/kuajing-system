"use client";

import { Banknote, ClipboardList, Clock3, LayoutDashboard, PackageSearch, ReceiptText, Store, Upload } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { AuthenticatedIdentity } from "@/modules/identity/principal";

import { MerchantShellFrame } from "./merchant-shell-frame";
import { MerchantTopbar } from "./merchant-topbar";
import { MobileTaskDock } from "./mobile-task-dock";
import { NavigationSection, type NavigationItem } from "./navigation-section";

const customerNavigation: Array<{
  id: string;
  label?: string;
  items: NavigationItem[];
}> = [
  {
    id: "customer-overview",
    items: [{ href: "/portal", icon: LayoutDashboard, label: "客户首页", exact: true }],
  },
  {
    id: "customer-purchasing",
    label: "拿货",
    items: [
      { href: "/portal/catalog", icon: PackageSearch, label: "货盘选品" },
      { href: "/portal/imports/new", icon: Upload, label: "上传 TEMU 订单" },
      { href: "/portal/bulk-orders", icon: Store, label: "多店铺批量拿货" },
    ],
  },
  {
    id: "customer-orders-payment",
    label: "订单与付款",
    items: [
      { href: "/portal/orders", icon: ClipboardList, label: "我的订单" },
      {
        href: "/portal/orders?status=PENDING_PAYMENT",
        icon: Clock3,
        label: "待付款",
        exact: true,
      },
      { href: "/portal/settlements", icon: ReceiptText, label: "批量付款" },
      { href: "/portal/wallet", icon: Banknote, label: "余额与流水" },
    ],
  },
];

function CustomerNavigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const activePath = query ? `${pathname}?${query}` : pathname;

  return (
    <nav aria-label="客户主导航" className="space-y-2 px-3 py-3">
      {customerNavigation.map((group) => (
        <NavigationSection
          activePath={activePath}
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

export function CustomerShell({
  children,
  identity,
}: {
  children: ReactNode;
  identity: AuthenticatedIdentity;
}) {
  return (
    <MerchantShellFrame
      audience="customer"
      mobileDock={
        <MobileTaskDock
          ariaLabel="客户快捷导航"
          items={[
            { exact: true, href: "/portal", icon: LayoutDashboard, label: "首页" },
            { href: "/portal/imports/new", icon: Upload, label: "上传" },
            { href: "/portal/orders", icon: ClipboardList, label: "订单" },
            { href: "/portal/wallet", icon: Banknote, label: "余额" },
          ]}
        />
      }
      navigation={<CustomerNavigation />}
      topbar={
        <MerchantTopbar
          audience="customer"
          identity={identity}
          mobileNavigation={<CustomerNavigation mobile />}
          mobileNavigationTitle="客户导航"
          roleLabel="合作客户"
          subtitle="加拿大本地货盘 · 多店铺统一拿货"
          title="同舟行客户中心"
        />
      }
    >
      {children}
    </MerchantShellFrame>
  );
}
