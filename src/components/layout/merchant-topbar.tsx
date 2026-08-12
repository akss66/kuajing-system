"use client";

import { Bell, CircleHelp, Menu, MessageSquareMore, ShieldCheck, UserCircle2 } from "lucide-react";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

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
    <header
      className="sticky top-0 z-40 flex h-13 items-center justify-between border-b border-black/8 bg-[var(--merchant-topbar)] px-3 text-[var(--merchant-topbar-foreground)] sm:px-5 lg:px-6"
      data-merchant-topbar={audience}
    >
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
            className="w-[312px] gap-0 border-r border-border bg-[var(--merchant-sidebar)] p-0 text-foreground"
            side="left"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{mobileNavigationTitle}</SheetTitle>
            </SheetHeader>
            {mobileNavigation}
          </SheetContent>
        </Sheet>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-[var(--merchant-topbar-foreground)]">{title}</p>
          {subtitle ? (
            <p className="hidden truncate text-xs text-[var(--merchant-topbar-muted)] sm:block">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          aria-label="帮助"
          className="hidden rounded-md border-white/12 bg-transparent text-[var(--merchant-topbar-muted)] hover:bg-white/8 hover:text-white lg:inline-flex"
          size="icon-sm"
          variant="ghost"
        >
          <CircleHelp aria-hidden="true" />
        </Button>
        <Button
          aria-label="消息"
          className="hidden rounded-md border-white/12 bg-transparent text-[var(--merchant-topbar-muted)] hover:bg-white/8 hover:text-white lg:inline-flex"
          size="icon-sm"
          variant="ghost"
        >
          <MessageSquareMore aria-hidden="true" />
        </Button>
        <Button
          aria-label="通知"
          className="rounded-md border-white/12 bg-transparent text-[var(--merchant-topbar-muted)] hover:bg-white/8 hover:text-white"
          size="icon-sm"
          variant="ghost"
        >
          <Bell aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="打开账号菜单"
              className="h-9 gap-2 rounded-md border-white/12 bg-white/5 px-3 text-[var(--merchant-topbar-foreground)] hover:bg-white/10 hover:text-white"
              variant="outline"
            >
              <UserCircle2 aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">账号</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 rounded-lg border border-border bg-[var(--merchant-panel)] p-2 shadow-lg">
            <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-sm font-medium text-foreground">
              <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
              <span>{accountLabel}</span>
            </DropdownMenuLabel>
            <div className="px-2 pb-1 text-xs text-muted-foreground">{badgeLabel}</div>
            <DropdownMenuSeparator />
            <div className="px-1 pb-1 pt-1">
              <SignOutButton className="h-9 w-full justify-start rounded-md px-2.5" size="sm" variant="ghost" />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
