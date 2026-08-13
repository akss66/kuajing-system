import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type SettlementRegionKind = "balances" | "batches" | "review" | "transactions";

const defaultRegionTitles: Record<SettlementRegionKind, string> = {
  balances: "客户余额",
  batches: "结算批次",
  review: "待核款队列",
  transactions: "资金流水",
};

type SettlementWorkspaceProps = {
  children: ReactNode;
  className?: string;
};

type SettlementRegionProps = {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  description?: ReactNode;
  kind: SettlementRegionKind;
  title?: string;
};

export function SettlementWorkspace({ children, className }: SettlementWorkspaceProps) {
  return (
    <div className={cn("space-y-5", className)} data-settlement-workspace>
      {children}
    </div>
  );
}

export function SettlementRegion({
  action,
  children,
  className,
  contentClassName,
  description,
  kind,
  title = defaultRegionTitles[kind],
}: SettlementRegionProps) {
  const titleId = `settlement-${kind}-${title.replaceAll(/\s/g, "-")}`;

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background",
        className,
      )}
      data-settlement-region={kind}
    >
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink sm:text-[0.95rem]" id={titleId}>
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className={contentClassName}>{children}</div>
    </section>
  );
}

export type { SettlementRegionKind, SettlementRegionProps, SettlementWorkspaceProps };
