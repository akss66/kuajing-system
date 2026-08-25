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
      <div className="inline-flex min-h-[3.25rem] w-full items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface/70 p-1 sm:w-auto">
        {saleStatusOptions.map((option) => {
          const selected = option.value === value;
          return (
            <Button
              aria-label={option.accessibleName}
              aria-pressed={selected}
              className={selected
                ? "min-h-[45px] flex-1 border-primary/15 bg-background px-4 text-primary-hover shadow-[0_1px_2px_rgb(24_64_54/0.10)] hover:bg-background sm:flex-none"
                : "min-h-[45px] flex-1 border-transparent bg-transparent px-4 font-medium text-muted-foreground shadow-none hover:border-transparent hover:bg-background/70 hover:text-foreground sm:flex-none"}
              key={option.value}
              onClick={() => onValueChange(option.value)}
              type="button"
              variant="outline"
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
