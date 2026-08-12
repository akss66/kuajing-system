import { cn } from "@/lib/utils";

type MetricItem = {
  hint?: string;
  label: string;
  tone?: "default" | "success" | "warning" | "danger";
  value: string;
};

const toneClasses: Record<NonNullable<MetricItem["tone"]>, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <article
          className="rounded-[var(--radius-surface)] border border-border bg-[var(--merchant-panel)] px-4 py-3"
          key={`${item.label}-${item.value}`}
        >
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <p className={cn("mt-2 text-[1.65rem] font-semibold tracking-[-0.035em] tabular-nums", toneClasses[item.tone ?? "default"])}>
            {item.value}
          </p>
          {item.hint ? <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p> : null}
        </article>
      ))}
    </section>
  );
}
