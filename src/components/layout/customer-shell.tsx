"use client";

import {
  Banknote,
  ClipboardList,
  Clock3,
  LayoutDashboard,
  Menu,
  PackageSearch,
  Store,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BRAND } from "@/shared/brand";

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
    <nav aria-label="客户主导航" className="space-y-1 px-3">
      {items.map((item) => {
        const content = (
          <>
            <item.icon aria-hidden="true" className="size-[18px]" />
            <span className="flex-1">{item.label}</span>
            {!item.href ? <span className="text-[10px] text-muted">即将开放</span> : null}
          </>
        );

        if (!item.href) {
          return (
            <div
              aria-disabled="true"
              className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted/65"
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
            : pathname.startsWith(item.href) &&
              !(item.href === "/portal/orders" && searchParams.has("status"));
        const link = (
          <Link
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium",
              active
                ? "bg-primary-soft text-primary-hover"
                : "text-muted hover:bg-surface-muted hover:text-ink",
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
    <div className="flex h-18 items-center gap-3 border-b border-border px-5">
      <Image
        alt=""
        className="h-9 w-auto object-contain"
        height={36}
        src={BRAND.logoPath}
        width={38}
      />
      <div>
        <p className="text-sm font-semibold text-ink">{BRAND.name}</p>
        <p className="text-[11px] text-muted">客户拿货中心</p>
      </div>
    </div>
  );
}

export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-surface">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-background lg:block">
        <PortalBrand />
        <div className="py-4">
          <PortalNavigation />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  aria-label="打开导航"
                  className="min-h-11 min-w-11 lg:hidden"
                  size="icon"
                  variant="outline"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent className="w-[296px] p-0" side="left">
                <SheetHeader className="sr-only">
                  <SheetTitle>客户导航</SheetTitle>
                </SheetHeader>
                <PortalBrand />
                <div className="py-4">
                  <PortalNavigation mobile />
                </div>
              </SheetContent>
            </Sheet>
            <p className="text-sm font-semibold text-ink">同舟行客户中心</p>
          </div>
          <span className="rounded-full bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary-hover">
            合作客户
          </span>
        </header>

        <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
