"use client";

import { Banknote, ClipboardList, Clock3, LayoutDashboard, PackageSearch, Store, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BRAND } from "@/shared/brand";

import { MerchantTopbar } from "./merchant-topbar";

const items: Array<{ href?: string; icon: LucideIcon; label: string }> = [
  { href: "/portal", icon: LayoutDashboard, label: "工作台" },
  { href: "/portal/catalog", icon: PackageSearch, label: "货盘选品" },
  { href: "/portal/imports/new", icon: Upload, label: "上传 TEMU 订单" },
  { href: "/portal/bulk-orders", icon: Store, label: "多店铺批量拿货" },
  { href: "/portal/orders", icon: ClipboardList, label: "我的订单" },
  { href: "/portal/orders?status=PENDING_PAYMENT", icon: Clock3, label: "待付款" },
  { href: "/portal/wallet", icon: Banknote, label: "余额与流水" },
  { icon: Store, label: "店铺数据" },
];

function PortalNavigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <nav aria-label="客户主导航" className="space-y-1.5 px-3 py-3">
      {items.map((item) => {
        const content = (
          <>
            <item.icon aria-hidden="true" className="size-[18px]" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {!item.href ? (
              <Badge className="rounded-md border-0 bg-surface-muted px-1.5 text-[10px] font-medium text-muted-foreground" variant="outline">
                即将开放
              </Badge>
            ) : null}
          </>
        );

        if (!item.href) {
          return (
            <div
              aria-disabled="true"
              className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm text-muted-foreground/70"
              key={item.label}
            >
              {content}
            </div>
          );
        }

        const [itemPath, itemQuery] = item.href.split("?");
        const active = itemQuery
          ? pathname === itemPath && searchParams.toString() === itemQuery
          : item.href === "/portal"
            ? pathname === item.href
            : pathname.startsWith(item.href) && !(item.href === "/portal/orders" && searchParams.has("status"));

        const link = (
          <Link
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors",
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

function PortalBrand() {
  return (
    <div className="flex h-16 items-center gap-3 border-b border-border px-4">
      <Image alt="" className="h-9 w-auto object-contain" height={36} src={BRAND.logoPath} width={38} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-foreground">{BRAND.name}</p>
        <p className="text-[11px] text-muted-foreground">客户拿货中心</p>
      </div>
    </div>
  );
}

function MobileNavigation() {
  return (
    <>
      <PortalBrand />
      <PortalNavigation mobile />
    </>
  );
}

export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-surface">
      <aside className="fixed inset-y-0 left-0 hidden w-56 border-r border-border bg-[var(--merchant-sidebar)] lg:block">
        <PortalBrand />
        <PortalNavigation />
      </aside>

      <div className="lg:pl-56">
        <MerchantTopbar
          audience="customer"
          badgeLabel="合作客户"
          mobileNavigation={<MobileNavigation />}
          mobileNavigationTitle="客户导航"
          subtitle="加拿大本地货盘 · 多店铺统一拿货"
          title="同舟行客户中心"
        />
        <main className="mx-auto max-w-[1480px] bg-[var(--merchant-canvas)] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
