"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type MobileTaskDockItem = {
  exact?: boolean;
  href: string;
  icon: LucideIcon;
  label: string;
};

function itemIsActive(pathname: string, item: MobileTaskDockItem) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function MobileTaskDock({
  ariaLabel,
  items,
}: {
  ariaLabel: string;
  items: MobileTaskDockItem[];
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label={ariaLabel}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/97 pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_20px_oklch(0.22_0.018_175/0.08)] backdrop-blur lg:hidden"
      data-mobile-task-dock
    >
      <div className="mx-auto grid h-[var(--merchant-mobile-dock-height)] max-w-xl grid-flow-col auto-cols-fr px-2">
        {items.map((item) => {
          const active = itemIsActive(pathname, item);
          const Icon = item.icon;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium outline-none transition-colors",
                "after:absolute after:inset-x-4 after:top-0 after:h-0.5 after:rounded-full",
                active
                  ? "text-primary-hover after:bg-primary"
                  : "text-muted-foreground after:bg-transparent hover:text-foreground",
              )}
              href={item.href}
              key={item.href}
            >
              <Icon aria-hidden="true" className="size-[18px]" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
