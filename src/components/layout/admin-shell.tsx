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
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BRAND } from "@/shared/brand";

import { MerchantTopbar } from "./merchant-topbar";

type NavigationItem = {
  href?: string;
  icon: LucideIcon;
  label: string;
};

function navigationForRole(principalKind: "ADMIN" | "SUPER_ADMIN"): NavigationItem[] {
  return [
    { href: "/admin", icon: LayoutDashboard, label: "运营总览" },
    { href: "/admin/customers", icon: Building2, label: "客户与店铺" },
    ...(principalKind === "SUPER_ADMIN"
      ? [{ href: "/admin/accounts", icon: Settings2, label: "账号管理" } satisfies NavigationItem]
      : []),
    { href: "/admin/catalog", icon: PackageSearch, label: "商品与 SKU" },
    { href: "/admin/inventory", icon: Boxes, label: "货盘库存" },
    { href: "/admin/orders", icon: ClipboardList, label: "订单管理" },
    { href: "/admin/bulk-orders", icon: FileSearch, label: "批量草稿诊断" },
    { href: "/admin/replacements", icon: RotateCcw, label: "补发管理" },
    { href: "/admin/settlement", icon: Banknote, label: "收款与余额" },
    { href: "/admin/settlement-batches", icon: WalletCards, label: "统一结算批次" },
    { href: "/admin/reports", icon: BarChart3, label: "报表分析" },
    { href: "/admin/notifications", icon: BellRing, label: "系统通知" },
    { href: "/admin/system/integrations", icon: PlugZap, label: "外部集成" },
    { href: "/admin/system/health", icon: Activity, label: "系统健康" },
    { href: "/admin/system/audit", icon: Settings2, label: "审计日志" },
  ];
}

function BrandBlock() {
  return (
    <div className="flex h-16 items-center gap-3 border-b border-border px-4">
      <Image alt="" className="h-9 w-auto object-contain" height={36} priority src={BRAND.logoPath} width={38} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-foreground">{BRAND.name}</p>
        <p className="text-[11px] text-muted-foreground">商家运营后台</p>
      </div>
    </div>
  );
}

function Navigation({
  mobile = false,
  principalKind,
}: {
  mobile?: boolean;
  principalKind: "ADMIN" | "SUPER_ADMIN";
}) {
  const pathname = usePathname();
  const navigation = navigationForRole(principalKind);

  return (
    <nav aria-label="管理员主导航" className="space-y-1.5 px-3 py-3">
      {navigation.map((item) => {
        const active = item.href
          ? item.href === "/admin"
            ? pathname === item.href
            : pathname.startsWith(item.href)
          : false;
        const content = (
          <>
            <item.icon aria-hidden="true" className="size-[18px]" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {!item.href ? (
              <Badge className="rounded-md border-0 bg-surface-muted px-1.5 text-[10px] font-medium text-muted-foreground" variant="outline">
                后续
              </Badge>
            ) : null}
          </>
        );

        if (!item.href) {
          return (
            <div
              aria-disabled="true"
              className="flex min-h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm text-muted-foreground/70"
              key={item.label}
            >
              {content}
            </div>
          );
        }

        const link = (
          <Link
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors",
              active
                ? "bg-[var(--merchant-nav-active)] text-[var(--merchant-nav-active-foreground)]"
                : "text-muted-foreground hover:bg-[var(--merchant-nav-hover)] hover:text-foreground",
            )}
            href={item.href}
          >
            {content}
          </Link>
        );

        return mobile ? (
          <SheetClose asChild key={item.label}>
            {link}
          </SheetClose>
        ) : (
          <div key={item.label}>{link}</div>
        );
      })}
    </nav>
  );
}

function MobileNavigation({ principalKind }: { principalKind: "ADMIN" | "SUPER_ADMIN" }) {
  return (
    <>
      <BrandBlock />
      <Navigation mobile principalKind={principalKind} />
    </>
  );
}

export function AdminShell({
  children,
  principalKind,
}: {
  children: ReactNode;
  principalKind: "ADMIN" | "SUPER_ADMIN";
}) {
  const badgeLabel = principalKind === "SUPER_ADMIN" ? "超级管理员" : "普通管理员";
  const helperText =
    principalKind === "SUPER_ADMIN" ? "可管理账号、客户与店铺" : "负责客户、订单与店铺日常运营";

  return (
    <div className="min-h-svh bg-surface">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 border-r border-border bg-[var(--merchant-sidebar)] lg:block">
        <BrandBlock />
        <div className="py-3">
          <p className="px-6 text-[11px] font-semibold tracking-[0.1em] text-muted-foreground">运营工作台</p>
          <Navigation principalKind={principalKind} />
        </div>
        <div className="absolute inset-x-3 bottom-3 rounded-[var(--radius-surface)] border border-border bg-[var(--merchant-panel)] px-3 py-3">
          <p className="text-xs font-semibold text-foreground">{badgeLabel}</p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{helperText}</p>
        </div>
      </aside>

      <div className="lg:pl-56">
        <MerchantTopbar
          audience="admin"
          badgeLabel={badgeLabel}
          mobileNavigation={<MobileNavigation principalKind={principalKind} />}
          mobileNavigationTitle="管理员导航"
          subtitle="加拿大本地货盘 · TEMU 一件代发"
          title="同舟行运营中心"
        />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{children}</main>
      </div>
    </div>
  );
}
