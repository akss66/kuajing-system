import Link from "next/link";

import { cn } from "@/lib/utils";

const items = [
  { href: "/admin/settlement", id: "payments", label: "收款审核" },
  { href: "/admin/wallets", id: "wallets", label: "客户余额" },
  { href: "/admin/settlement-batches", id: "combined", label: "合并付款审核" },
] as const;

export function AdminFinanceNavigation({
  active,
}: {
  active: (typeof items)[number]["id"];
}) {
  return (
    <nav
      aria-label="资金管理"
      className="flex min-w-0 gap-1 overflow-x-auto rounded-[var(--radius-surface)] border border-border bg-background p-1"
    >
      {items.map((item) => (
        <Link
          aria-current={active === item.id ? "page" : undefined}
          className={cn(
            "flex min-h-10 shrink-0 items-center rounded-[var(--radius-control)] px-4 text-sm font-medium transition-colors",
            active === item.id
              ? "bg-primary-soft text-primary-hover"
              : "text-muted hover:bg-surface-muted hover:text-ink",
          )}
          href={item.href}
          key={item.id}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
