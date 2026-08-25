"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { SheetClose } from "@/components/ui/sheet";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export type NavigationItem = {
  activePrefixes?: string[];
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
};

export type NavigationSectionProps = {
  id: string;
  label?: string;
  items: NavigationItem[];
  activePath: string;
  mobile?: boolean;
};

function matchesPath(item: NavigationItem, activePath: string) {
  const activePathname = activePath.split("?")[0];
  const itemPathname = item.href.split("?")[0];
  if (
    item.activePrefixes?.some(
      (prefix) => activePathname === prefix || activePathname.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  if (item.exact) return activePath === item.href;

  return activePathname === itemPathname || activePathname.startsWith(`${itemPathname}/`);
}

function activeHref(items: NavigationItem[], activePath: string) {
  const exactMatch = items.find((item) => item.href === activePath);
  if (exactMatch) return exactMatch.href;

  return items
    .filter((item) => matchesPath(item, activePath))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}

export function NavigationSection({
  activePath,
  id,
  items,
  label,
  mobile = false,
}: NavigationSectionProps) {
  const currentHref = useMemo(() => activeHref(items, activePath), [activePath, items]);
  const containsCurrentPage = currentHref !== undefined;

  return (
    <SidebarGroup
      className={cn("p-0", label ? "mt-5 first:mt-0" : "")}
      data-current-group={containsCurrentPage}
      data-navigation-section={id}
    >
      {label ? (
        <SidebarGroupLabel
          asChild
          className="h-auto rounded-none px-3 pb-2 pt-0 text-xs font-medium tracking-normal text-muted-foreground"
        >
          <h2>{label}</h2>
        </SidebarGroupLabel>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => {
            const active = item.href === currentHref;
            const link = (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors before:absolute before:left-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:rounded-full",
                  mobile ? "min-h-11" : "min-h-10",
                  active
                    ? "bg-[var(--merchant-nav-active)] text-[var(--merchant-nav-active-foreground)] before:w-0.5 before:bg-[var(--merchant-nav-active-foreground)]"
                    : "text-muted-foreground before:w-0 hover:bg-[var(--merchant-nav-hover)] hover:text-foreground",
                )}
                data-motion-state={active ? "current" : "idle"}
                href={item.href}
              >
                <span
                  className="flex size-6 shrink-0 items-center justify-center"
                  data-navigation-icon
                >
                  <item.icon aria-hidden="true" className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </Link>
            );

            return (
              <SidebarMenuItem key={item.href}>
                {mobile ? <SheetClose asChild>{link}</SheetClose> : link}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
