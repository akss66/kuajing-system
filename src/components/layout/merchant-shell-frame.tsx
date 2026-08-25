import Image from "next/image";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { BRAND } from "@/shared/brand";

export type MerchantAudience = "admin" | "customer";

export type MerchantShellFrameProps = {
  audience: MerchantAudience;
  navigation: ReactNode;
  topbar: ReactNode;
  desktopSidebarFooter?: ReactNode;
  mobileDock: ReactNode;
  children: ReactNode;
};

export function MerchantBrand({
  audience,
  className,
}: {
  audience: MerchantAudience;
  className?: string;
}) {
  const audienceLabel = audience === "admin" ? "商家运营后台" : "客户拿货中心";

  return (
    <div
      className={cn(
        "flex h-[var(--merchant-header-height)] shrink-0 items-center gap-3 px-4",
        className,
      )}
      data-merchant-brand
    >
      <Image
        alt=""
        className={cn(
          "h-8 w-auto shrink-0 object-contain",
          audience === "customer" && "drop-shadow-[0_2px_5px_rgb(197_20_28/0.18)]",
        )}
        height={656}
        priority
        src={BRAND.logoPath}
        width={683}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-[var(--merchant-topbar-foreground)]">
          {BRAND.name}
        </p>
        <p className="text-[11px] text-[var(--merchant-topbar-muted)]">{audienceLabel}</p>
      </div>
    </div>
  );
}

export function MerchantShellFrame({
  audience,
  navigation,
  topbar,
  desktopSidebarFooter,
  mobileDock,
  children,
}: MerchantShellFrameProps) {
  return (
    <div
      className={cn(
        "min-h-svh min-w-0 bg-[var(--merchant-canvas)]",
        audience === "customer" && "portal-design",
      )}
      data-design-audience={audience === "customer" ? "portal" : "admin"}
      data-merchant-shell={audience}
      data-shell-version="v2"
      data-testid="merchant-shell"
    >
      <a
        className="fixed left-3 top-3 z-[60] -translate-y-24 rounded-md bg-background px-4 py-3 text-sm font-semibold text-foreground shadow-lg transition-transform focus:translate-y-0"
        href="#merchant-main-content"
      >
        跳到主要内容
      </a>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-40 flex h-[var(--merchant-header-height)] border-b border-[color-mix(in_oklch,var(--merchant-topbar),white_14%)] bg-[var(--merchant-topbar)] text-[var(--merchant-topbar-foreground)]",
          audience === "customer" && "lg:hidden",
        )}
        data-merchant-topbar={audience}
      >
        <MerchantBrand
          audience={audience}
          className="hidden w-[var(--merchant-sidebar-width)] lg:flex"
        />
        <div className="min-w-0 flex-1">{topbar}</div>
      </header>

      <aside
        className={cn(
          "fixed bottom-0 left-0 z-30 hidden w-[var(--merchant-sidebar-width)] border-r border-border bg-[var(--merchant-sidebar)]",
          audience === "customer"
            ? "top-0 flex-col lg:flex"
            : "top-[var(--merchant-header-height)] overflow-y-auto lg:block",
        )}
        data-merchant-sidebar
      >
        {audience === "customer" ? (
          <>
            <MerchantBrand audience="customer" className="mt-2 h-20 px-6" />
            <div className="min-h-0 flex-1 overflow-y-auto">{navigation}</div>
            {desktopSidebarFooter ? (
              <div className="border-t border-slate-200/60 p-4" data-customer-sidebar-account>
                {desktopSidebarFooter}
              </div>
            ) : null}
          </>
        ) : navigation}
      </aside>

      <div
        className={cn(
          "min-w-0 pt-[var(--merchant-header-height)] lg:pl-[var(--merchant-sidebar-width)]",
          audience === "customer" && "lg:pt-0",
        )}
        data-merchant-content
      >
        <main
          className={cn(
            "mx-auto min-h-[calc(100svh-var(--merchant-header-height))] w-full min-w-0 bg-[var(--merchant-canvas)]",
            audience === "customer"
              ? "max-w-none pb-[calc(var(--merchant-mobile-dock-height)+1.5rem+env(safe-area-inset-bottom))] lg:min-h-svh lg:pb-0"
              : "max-w-[1600px] px-4 pb-[calc(var(--merchant-mobile-dock-height)+1.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:px-8 lg:py-6",
          )}
          data-portal-main={audience === "customer" ? true : undefined}
          id="merchant-main-content"
          tabIndex={-1}
        >
          <div
            className={
              audience === "customer"
                ? "customer-surface-enter mx-auto w-full max-w-5xl px-4 pt-5 sm:px-6 lg:px-12 lg:py-12"
                : undefined
            }
          >
            {children}
          </div>
        </main>
      </div>
      {mobileDock}
    </div>
  );
}
