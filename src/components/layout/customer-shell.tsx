"use client";

import { Banknote, ClipboardList, LayoutDashboard, PackageSearch, Upload } from "lucide-react";
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
      { href: "/portal/catalog", icon: PackageSearch, label: "实时货盘" },
      { activePrefixes: ["/portal/bulk-orders"], href: "/portal/imports/new", icon: Upload, label: "上传订单" },
    ],
  },
  {
    id: "customer-fulfillment",
    label: "履约",
    items: [{ href: "/portal/orders", icon: ClipboardList, label: "我的订单" }],
  },
  {
    id: "customer-funds",
    label: "资金",
    items: [{ href: "/portal/wallet", icon: Banknote, label: "资金中心" }],
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
            { activePrefixes: ["/portal/bulk-orders"], href: "/portal/imports/new", icon: Upload, label: "上传" },
            { href: "/portal/orders", icon: ClipboardList, label: "订单" },
            { href: "/portal/wallet", icon: Banknote, label: "资金" },
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
