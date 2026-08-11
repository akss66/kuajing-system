"use client";

import {
  Banknote,
  BarChart3,
  BellRing,
  Boxes,
  Building2,
  ClipboardList,
  LayoutDashboard,
  Menu,
  PackageSearch,
  RotateCcw,
  PlugZap,
  Settings2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
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

type NavigationItem = {
  href?: string;
  icon: LucideIcon;
  label: string;
};

const navigation: NavigationItem[] = [
  { href: "/admin", icon: LayoutDashboard, label: "运营总览" },
  { href: "/admin/customers", icon: Building2, label: "客户与店铺" },
  { href: "/admin/catalog", icon: PackageSearch, label: "商品与 SKU" },
  { href: "/admin/inventory", icon: Boxes, label: "货盘库存" },
  { href: "/admin/orders", icon: ClipboardList, label: "订单管理" },
  { href: "/admin/replacements", icon: RotateCcw, label: "补发管理" },
  { href: "/admin/settlement", icon: Banknote, label: "收款与余额" },
  { href: "/admin/reports", icon: BarChart3, label: "报表分析" },
  { href: "/admin/notifications", icon: BellRing, label: "系统通知" },
  { href: "/admin/system/integrations", icon: PlugZap, label: "外部集成" },
  { href: "/admin/system/audit", icon: Settings2, label: "审计日志" },
];

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label="管理员主导航" className="space-y-1 px-3">
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
              <Badge className="border-0 bg-surface-muted px-1.5 text-[10px] font-normal text-muted" variant="outline">
                后续
              </Badge>
            ) : null}
          </>
        );

        if (!item.href) {
          return (
            <div
              aria-disabled="true"
              className="flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm text-muted/65"
              key={item.label}
            >
              {content}
            </div>
          );
        }

        const link = (
          <Link
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
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

function BrandBlock() {
  return (
    <div className="flex h-18 items-center gap-3 border-b border-border px-5">
      <Image alt="" className="h-9 w-auto object-contain" height={36} priority src={BRAND.logoPath} width={38} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-ink">{BRAND.name}</p>
        <p className="text-[11px] text-muted">运营管理后台</p>
      </div>
    </div>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-surface">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-background lg:block">
        <BrandBlock />
        <div className="py-4">
          <p className="mb-2 px-6 text-[11px] font-semibold tracking-[0.1em] text-muted">运营工作台</p>
          <Navigation />
        </div>
        <div className="absolute inset-x-3 bottom-3 rounded-lg border border-border bg-surface px-3 py-3">
          <p className="text-xs font-medium text-ink">超级管理员</p>
          <p className="mt-0.5 text-[11px] text-muted">全部管理权限</p>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Sheet>
              <SheetTrigger asChild>
                <Button aria-label="打开导航" className="min-h-11 min-w-11 lg:hidden" size="icon" variant="outline">
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent className="w-[296px] p-0" side="left">
                <SheetHeader className="sr-only">
                  <SheetTitle>管理员导航</SheetTitle>
                </SheetHeader>
                <BrandBlock />
                <div className="py-4">
                  <Navigation mobile />
                </div>
              </SheetContent>
            </Sheet>
            <div>
              <p className="text-sm font-medium text-ink">同舟行运营中心</p>
              <p className="hidden text-xs text-muted sm:block">加拿大货盘 · 一件代发</p>
            </div>
          </div>
          <div className="flex size-9 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-hover" aria-label="超级管理员">
            管
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
