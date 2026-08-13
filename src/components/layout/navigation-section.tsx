"use client";

import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";

import { SheetClose } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type NavigationItem = {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
};

export type NavigationSectionProps = {
  id: string;
  label: string;
  items: NavigationItem[];
  defaultOpen: boolean;
  activePath: string;
  mobile?: boolean;
};

const navigationStateEvent = "merchant-navigation-state";

function subscribeToNavigationState(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(navigationStateEvent, callback);

  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(navigationStateEvent, callback);
  };
}

function matchesPath(item: NavigationItem, activePath: string) {
  if (item.exact) return activePath === item.href;

  const activePathname = activePath.split("?")[0];
  const itemPathname = item.href.split("?")[0];
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
  id,
  label,
  items,
  defaultOpen,
  activePath,
  mobile = false,
}: NavigationSectionProps) {
  const currentHref = useMemo(() => activeHref(items, activePath), [activePath, items]);
  const containsCurrentPage = currentHref !== undefined;
  const storageKey = `merchant-navigation-section:${id}`;
  const contentId = `${id}-${mobile ? "mobile" : "desktop"}-items`;
  const persistedState = useSyncExternalStore(
    subscribeToNavigationState,
    () => window.localStorage.getItem(storageKey),
    () => null,
  );
  const [localState, setLocalState] = useState<{
    activePath: string;
    open: boolean;
  } | null>(null);
  const persistedOpen = persistedState === null ? defaultOpen : persistedState === "true";
  const open =
    localState?.activePath === activePath
      ? localState.open
      : containsCurrentPage || persistedOpen;

  function toggleSection() {
    const nextOpen = !open;
    setLocalState({ activePath, open: nextOpen });
    window.localStorage.setItem(storageKey, String(nextOpen));
    window.dispatchEvent(new Event(navigationStateEvent));
  }

  return (
    <section className="space-y-1" data-navigation-section={id}>
      <h2>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center justify-between rounded-md px-3 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground transition-colors hover:bg-[var(--merchant-nav-hover)] hover:text-foreground",
            mobile ? "min-h-11" : "min-h-8",
          )}
          onClick={toggleSection}
          type="button"
        >
          <span>{label}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
        </button>
      </h2>

      <ul className="space-y-0.5" hidden={!open} id={contentId}>
        {items.map((item) => {
          const active = item.href === currentHref;
          const link = (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors",
                mobile ? "min-h-11" : "min-h-10",
                active
                  ? "bg-[var(--merchant-nav-active)] text-[var(--merchant-nav-active-foreground)]"
                  : "text-muted-foreground hover:bg-[var(--merchant-nav-hover)] hover:text-foreground",
              )}
              href={item.href}
            >
              <item.icon aria-hidden="true" className="size-[18px] shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </Link>
          );

          return (
            <li key={item.href}>
              {mobile ? <SheetClose asChild>{link}</SheetClose> : link}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
