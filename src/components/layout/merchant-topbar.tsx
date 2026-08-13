"use client";

import { Bell, Menu, ShieldCheck, UserCircle2, X } from "lucide-react";
import type { ReactNode } from "react";

import { SignOutMenuItem } from "@/components/auth/sign-out-button";
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
};

export function MerchantTopbar({
  audience,
  identity,
  mobileNavigation,
  mobileNavigationTitle,
  roleLabel,
  subtitle,
  title,
}: MerchantTopbarProps) {
  const displayName = identity.displayName?.trim() || "未设置姓名";

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
        <DropdownMenu modal={false}>
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
            <DropdownMenuLabel className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-2 py-1 text-foreground sm:py-1.5">
              <UserCircle2 aria-hidden="true" className="mt-0.5 size-4 text-primary" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium" title={displayName}>
                  {displayName}
                </span>
                <span className="mt-0.5 block break-all text-xs font-normal text-muted-foreground">
                  {identity.email}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuLabel className="flex items-center gap-2 px-2 pb-0.5 text-xs font-normal text-muted-foreground sm:pb-1">
              <ShieldCheck aria-hidden="true" className="size-3.5 text-primary" />
              <span>{roleLabel}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <SignOutMenuItem className="mx-0.5 my-0.5 min-h-11 cursor-pointer justify-start px-2 text-sm sm:mx-1 sm:my-1 sm:min-h-9 sm:px-2.5" />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
