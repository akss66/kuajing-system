import Image from "next/image";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { BRAND } from "@/shared/brand";

export type MerchantAudience = "admin" | "customer";

export type MerchantShellFrameProps = {
  audience: MerchantAudience;
  navigation: ReactNode;
  topbar: ReactNode;
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
        className="h-8 w-auto shrink-0 object-contain"
        height={656}
        priority={audience === "admin"}
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
  children,
}: MerchantShellFrameProps) {
  return (
    <div
      className="min-h-svh min-w-0 bg-[var(--merchant-canvas)]"
      data-merchant-shell={audience}
      data-shell-version="v2"
      data-testid="merchant-shell"
    >
      <header
        className="fixed inset-x-0 top-0 z-40 flex h-[var(--merchant-header-height)] border-b border-[color-mix(in_oklch,var(--merchant-topbar),white_14%)] bg-[var(--merchant-topbar)] text-[var(--merchant-topbar-foreground)]"
        data-merchant-topbar={audience}
      >
        <MerchantBrand
          audience={audience}
          className="hidden w-[var(--merchant-sidebar-width)] lg:flex"
        />
        <div className="min-w-0 flex-1">{topbar}</div>
      </header>

      <aside
        className="fixed bottom-0 left-0 top-[var(--merchant-header-height)] z-30 hidden w-[var(--merchant-sidebar-width)] overflow-y-auto border-r border-border bg-[var(--merchant-sidebar)] lg:block"
        data-merchant-sidebar
      >
        {navigation}
      </aside>

      <div
        className="min-w-0 pt-[var(--merchant-header-height)] lg:pl-[var(--merchant-sidebar-width)]"
        data-merchant-content
      >
        <main className="mx-auto min-h-[calc(100svh-var(--merchant-header-height))] w-full max-w-[1600px] min-w-0 bg-[var(--merchant-canvas)] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
