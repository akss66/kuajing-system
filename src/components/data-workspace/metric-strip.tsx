import { cn } from "@/lib/utils";

type MetricItem = {
  hint?: string;
  label: string;
  tone?: "default" | "success" | "warning" | "danger";
  value: string;
};

type MetricStripColumns = 2 | 3 | 4 | 5;

const toneClasses: Record<NonNullable<MetricItem["tone"]>, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

const columnClasses: Record<MetricStripColumns, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
  4: "grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
};

const segmentedColumnClasses: Record<MetricStripColumns, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 lg:grid-cols-3",
  4: "grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
};

export function MetricStrip({
  className,
  columns,
  compact = false,
  items,
  variant = "cards",
}: {
  className?: string;
  columns?: MetricStripColumns;
  compact?: boolean;
  items: MetricItem[];
  variant?: "cards" | "segmented";
}) {
  const resolvedColumns =
    columns ?? (Math.min(Math.max(items.length, 2), 5) as MetricStripColumns);
  const segmented = variant === "segmented";

  return (
    <section
      className={cn(
        "grid",
        segmented
          ? "gap-0 overflow-hidden rounded-[var(--radius-surface)] border border-border bg-[var(--merchant-panel)]"
          : "gap-3",
        segmented
          ? segmentedColumnClasses[resolvedColumns]
          : columnClasses[resolvedColumns],
        className,
      )}
      data-metric-count={items.length}
      data-metric-strip
      data-metric-variant={variant}
    >
      {items.map((item, index) => (
        <article
          className={cn(
            segmented
              ? "rounded-none border-0 bg-transparent px-4 py-3.5 sm:px-5"
              : "rounded-[var(--radius-surface)] border border-border bg-[var(--merchant-panel)] px-4 py-3.5",
            items.length === 5 && index === 4
              ? "col-span-2 sm:col-span-1"
              : undefined,
          )}
          data-metric-card
          data-workspace-panel
          key={`${item.label}-${item.value}`}
        >
          <p className="text-[11px] font-medium text-muted-foreground">{item.label}</p>
          <p
            className={cn(
              compact
                ? "mt-1.5 text-[1.3rem] font-semibold tracking-[-0.03em] sm:text-[1.45rem]"
                : "mt-2 text-[1.5rem] font-semibold tracking-[-0.035em] sm:text-[1.65rem]",
              "tabular-nums",
              toneClasses[item.tone ?? "default"],
            )}
          >
            {item.value}
          </p>
          {item.hint ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.hint}</p>
          ) : null}
        </article>
      ))}
    </section>
  );
}
