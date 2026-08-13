"use client";

import { Bell, Menu, ShieldCheck, UserCircle2, X } from "lucide-react";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { MerchantBrand } from "./merchant-shell-frame";

type MerchantTopbarProps = {
  audience: "admin" | "customer";
  badgeLabel: string;
  mobileNavigation: ReactNode;
  mobileNavigationTitle: string;
  subtitle?: string;
  title: string;
};

export function MerchantTopbar({
  audience,
  badgeLabel,
  mobileNavigation,
  mobileNavigationTitle,
  subtitle,
  title,
}: MerchantTopbarProps) {
  const accountLabel = audience === "admin" ? "管理员账号" : "客户账号";

  return (
    <div className="flex h-full min-w-0 items-center justify-between px-3 sm:px-5 lg:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              aria-label="打开导航"
              className="size-11 rounded-md border-white/14 bg-white/4 text-[var(--merchant-topbar-foreground)] hover:bg-white/10 hover:text-white lg:hidden"
              size="icon"
              variant="outline"
            >
              <Menu aria-hidden="true" className="size-4.5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            className="w-[min(20rem,calc(100vw-2rem))] gap-0 border-r border-border bg-[var(--merchant-sidebar)] p-0 text-foreground"
            side="left"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{mobileNavigationTitle}</SheetTitle>
            </SheetHeader>
            <div className="relative bg-[var(--merchant-topbar)]">
              <MerchantBrand audience={audience} className="pr-14" />
              <SheetClose asChild>
                <Button
                  aria-label="关闭导航"
                  className="absolute right-1.5 top-1.5 size-11 rounded-md text-[var(--merchant-topbar-muted)] hover:bg-white/10 hover:text-white"
                  size="icon"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-4.5" />
                </Button>
              </SheetClose>
            </div>
            {mobileNavigation}
          </SheetContent>
        </Sheet>
        <div className="min-w-0 lg:hidden">
          <p className="truncate text-sm font-semibold tracking-tight text-[var(--merchant-topbar-foreground)]">{title}</p>
          {subtitle ? (
            <p className="hidden truncate text-xs text-[var(--merchant-topbar-muted)] sm:block">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          aria-label="通知"
          className="size-11 rounded-md border-white/12 bg-transparent text-[var(--merchant-topbar-muted)] hover:bg-white/8 hover:text-white"
          size="icon"
          variant="ghost"
        >
          <Bell aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="打开账号菜单"
              className="min-h-11 min-w-11 gap-2 rounded-md border-white/12 bg-white/5 px-3 text-[var(--merchant-topbar-foreground)] hover:bg-white/10 hover:text-white"
              variant="outline"
            >
              <UserCircle2 aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">账号</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[236px] rounded-lg border border-border bg-[var(--merchant-panel)] p-1.5 shadow-lg sm:w-64 sm:p-2"
            sideOffset={6}
          >
            <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1 text-sm font-medium text-foreground sm:py-1.5">
              <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
              <span>{accountLabel}</span>
            </DropdownMenuLabel>
            <div className="px-2 pb-0.5 text-xs text-muted-foreground sm:pb-1">{badgeLabel}</div>
            <DropdownMenuSeparator />
            <div className="px-0.5 py-0.5 sm:px-1 sm:py-1">
              <SignOutButton className="h-8.5 w-full justify-start rounded-md px-2 text-sm sm:h-9 sm:px-2.5" size="sm" variant="ghost" />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
