import { Button } from "@/components/ui/button";
import type { CatalogSaleStatusFilter } from "@/modules/catalog/product-groups";

const saleStatusOptions: Array<{
  label: string;
  value: CatalogSaleStatusFilter;
}> = [
  { label: "全部", value: "ALL" },
  { label: "可售", value: "SELLABLE" },
  { label: "不可售", value: "NOT_SELLABLE" },
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
      <div className="flex flex-wrap gap-2">
        {saleStatusOptions.map((option) => {
          const selected = option.value === value;
          return (
            <Button
              aria-label={option.label}
              aria-pressed={selected}
              className={selected ? "min-h-11 border-primary-hover bg-primary-soft font-semibold text-primary-hover hover:bg-primary-soft" : "min-h-11 border-dashed font-medium"}
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
