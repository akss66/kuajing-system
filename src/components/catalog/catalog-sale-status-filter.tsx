import { Button } from "@/components/ui/button";
import type { CatalogSaleStatusFilter } from "@/modules/catalog/product-groups";

const saleStatusOptions: Array<{
  accessibleName: string;
  label: string;
  value: CatalogSaleStatusFilter;
}> = [
  { accessibleName: "查看全部 SKU", label: "全部", value: "ALL" },
  { accessibleName: "只看可售 SKU", label: "可售", value: "SELLABLE" },
  { accessibleName: "只看不可售 SKU", label: "不可售", value: "NOT_SELLABLE" },
];

export function CatalogSaleStatusFilterControl({
  onValueChange,
  value,
}: {
  value: CatalogSaleStatusFilter;
  onValueChange: (value: CatalogSaleStatusFilter) => void;
}): React.JSX.Element {
  return (
    <fieldset aria-label="销售状态筛选" className="min-w-0">
      <legend className="sr-only">销售状态筛选</legend>
      <div
        className="inline-flex h-12 w-full items-center gap-0.5 rounded-[var(--radius-control)] border border-input bg-[var(--portal-subtle-surface)] p-0.5 sm:w-auto"
        data-sale-status-segments
      >
        {saleStatusOptions.map((option) => {
          const selected = option.value === value;
          return (
            <Button
              aria-label={option.accessibleName}
              aria-pressed={selected}
              className={selected
                ? "min-h-11 flex-1 border-0 bg-background px-4 text-primary-hover shadow-[0_1px_2px_rgb(24_64_54/0.10)] hover:bg-background sm:flex-none"
                : "min-h-11 flex-1 border-0 bg-transparent px-4 font-medium text-muted-foreground shadow-none hover:bg-background/70 hover:text-foreground sm:flex-none"}
              key={option.value}
              onClick={() => onValueChange(option.value)}
              type="button"
              variant="ghost"
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
