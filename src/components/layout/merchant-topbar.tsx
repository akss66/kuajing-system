"use client";

import { Bell, ChevronDown, Menu, ShieldCheck, UserCircle2, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutMenuItem } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import type { AuthenticatedIdentity } from "@/modules/identity/principal";

import { MerchantBrand } from "./merchant-shell-frame";

type MerchantTopbarProps = {
  audience: "admin" | "customer";
  identity: AuthenticatedIdentity;
  mobileNavigation: ReactNode;
  mobileNavigationTitle: string;
  roleLabel: string;
  subtitle?: string;
  title: string;
  placement?: "sidebar" | "topbar";
};

export function MerchantTopbar({
  audience,
  identity,
  mobileNavigation,
  mobileNavigationTitle,
  roleLabel,
  subtitle,
  title,
  placement = "topbar",
}: MerchantTopbarProps) {
  const displayName = identity.displayName?.trim() || "未设置姓名";
  const displayInitial = Array.from(displayName)[0] ?? "账";

  const accountMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={placement === "sidebar" ? "打开侧栏账号菜单" : "打开账号菜单"}
          className={
            placement === "sidebar"
              ? "min-h-11 w-full justify-start gap-3 rounded-xl border-0 bg-transparent px-2 text-slate-700 hover:bg-slate-100 hover:text-slate-900"
              : "min-h-11 min-w-11 max-w-48 gap-2 rounded-md border-0 bg-transparent px-1.5 text-[var(--merchant-topbar-foreground)] hover:bg-white/8 hover:text-white sm:pl-1.5 sm:pr-2"
          }
          data-account-trigger="true"
          variant="ghost"
        >
          <span className={placement === "sidebar" ? "flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white" : "flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--merchant-nav-active)] text-xs font-semibold text-[var(--merchant-nav-active-foreground)]"}>
            {displayInitial}
          </span>
          <span className={placement === "sidebar" ? "min-w-0 flex-1 truncate text-left text-sm font-medium" : "hidden max-w-28 truncate text-sm font-medium sm:inline"}>{displayName}</span>
          <ChevronDown aria-hidden="true" className={placement === "sidebar" ? "size-3.5 text-slate-400" : "hidden size-3.5 text-[var(--merchant-topbar-muted)] sm:block"} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={placement === "sidebar" ? "start" : "end"}
        className="w-[236px] rounded-xl border border-slate-100 bg-[var(--merchant-panel)] p-1.5 shadow-xl sm:w-64 sm:p-2"
        side={placement === "sidebar" ? "top" : "bottom"}
        sideOffset={8}
      >
        <DropdownMenuLabel className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-2 py-1 text-foreground sm:py-1.5">
          <UserCircle2 aria-hidden="true" className="mt-0.5 size-4 text-primary" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium" title={displayName}>{displayName}</span>
            <span className="mt-0.5 block break-all text-xs font-normal text-muted-foreground">{identity.email}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuLabel className="flex items-center gap-2 px-2 pb-0.5 text-xs font-normal text-muted-foreground sm:pb-1">
          <ShieldCheck aria-hidden="true" className="size-3.5 text-primary" />
          <span>{roleLabel}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {audience === "customer" ? (
          <DropdownMenuItem asChild className="mx-0.5 my-0.5 min-h-11 cursor-pointer px-2 text-sm sm:mx-1 sm:my-1 sm:min-h-9 sm:px-2.5">
            <Link href="/portal/profile">
              <UserCircle2 aria-hidden="true" />
              个人中心
            </Link>
          </DropdownMenuItem>
        ) : null}
        <SignOutMenuItem className="mx-0.5 my-0.5 min-h-11 cursor-pointer justify-start px-2 text-sm sm:mx-1 sm:my-1 sm:min-h-9 sm:px-2.5" />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (placement === "sidebar") {
    return accountMenu;
  }

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
            className={
              audience === "customer"
                ? "data-[side=left]:!w-[min(18rem,calc(100vw-3rem))] data-[side=left]:!max-w-none gap-0 border-r border-border bg-[var(--merchant-sidebar)] p-0 text-foreground"
                : "w-[min(20rem,calc(100vw-2rem))] gap-0 border-r border-border bg-[var(--merchant-sidebar)] p-0 text-foreground"
            }
            data-mobile-navigation-drawer={audience}
            side="left"
            showCloseButton={false}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{mobileNavigationTitle}</SheetTitle>
            </SheetHeader>
            <div className="relative bg-[var(--merchant-topbar)]">
              <MerchantBrand
                audience={audience}
                className={audience === "customer" ? "h-16 pr-14 [&_img]:h-7" : "pr-14"}
              />
              <SheetClose asChild>
                <Button
                  aria-label="关闭导航"
                  className="absolute right-2.5 top-2.5 size-11 rounded-md text-[var(--merchant-topbar-muted)] hover:bg-white/10 hover:text-white"
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
        {audience === "admin" ? (
          <Button
            asChild
            className="size-11 rounded-md border-0 bg-transparent text-[var(--merchant-topbar-muted)] hover:bg-white/8 hover:text-white"
            size="icon"
            variant="ghost"
          >
            <Link aria-label="查看系统通知" href="/admin/notifications">
              <Bell aria-hidden="true" className="size-[18px]" />
            </Link>
          </Button>
        ) : null}
        {accountMenu}
      </div>
    </div>
  );
}
