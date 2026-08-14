export function InventoryAdjustmentPreview({
  afterTotal,
  beforeTotal,
  currentAvailable,
  delta,
  locked,
}: {
  afterTotal: number;
  beforeTotal: number;
  currentAvailable: number;
  delta: number;
  locked: number;
}) {
  const facts = [
    ["调整前总库存", beforeTotal],
    ["变化量", `${delta > 0 ? "+" : ""}${delta}`],
    ["调整后总库存", afterTotal],
    ["订单锁定", locked],
    ["当前可售", currentAvailable],
    ["调整后可售", Math.max(0, afterTotal - locked)],
  ] as const;

  return (
    <section
      aria-label="库存调整预览"
      className="rounded-[var(--radius-control)] bg-surface-muted p-4"
    >
      <h4 className="text-sm font-semibold text-foreground">调整预览</h4>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
