"use client";

import { Filter, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type FilterOption = {
  label: string;
  value: string;
};

type OrderFilterValues = {
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  orderNumber?: string;
  status?: string;
  storeId?: string;
};

type OrderFilterBarProps = {
  audience?: "admin" | "customer";
  customerOptions?: FilterOption[];
  statusOptions: FilterOption[];
  storeOptions?: FilterOption[];
  values: OrderFilterValues;
};

const ALL_OPTION_VALUE = "__all__";
const nativeSelectClassName =
  "min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18";

function FilterSelect({
  allLabel,
  label,
  name,
  native = false,
  options,
  value,
}: {
  allLabel: string;
  label: string;
  name: string;
  native?: boolean;
  options: FilterOption[];
  value?: string;
}) {
  return (
    <label className="space-y-2 text-sm font-medium text-ink" data-testid="common-order-filter">
      {label}
      {native ? (
        <select
          aria-label={label}
          className={nativeSelectClassName}
          defaultValue={value ?? ""}
          name={name}
        >
          <option value="">{allLabel}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Select defaultValue={value || ALL_OPTION_VALUE} name={name}>
          <SelectTrigger aria-label={label} className="min-h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={ALL_OPTION_VALUE}>{allLabel}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </label>
  );
}

function optionLabel(options: FilterOption[] | undefined, value: string | undefined) {
  return options?.find((option) => option.value === value)?.label ?? value;
}

export function OrderFilterBar({
  audience = "admin",
  customerOptions = [],
  statusOptions,
  storeOptions = [],
  values,
}: OrderFilterBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isCustomer = audience === "customer";

  function replaceParams(update: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    update(params);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function applyFields(event: FormEvent<HTMLFormElement>, fields: string[]) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    replaceParams((params) => {
      for (const field of fields) {
        const rawValue = String(formData.get(field) ?? "").trim();
        const nextValue = rawValue === ALL_OPTION_VALUE ? "" : rawValue;
        if (nextValue) params.set(field, nextValue);
        else params.delete(field);
      }
    });
  }

  const activeFilters = [
    values.orderNumber
      ? { key: "orderNumber", label: "拿货单号", value: values.orderNumber }
      : null,
    values.status
      ? { key: "status", label: "状态", value: optionLabel(statusOptions, values.status) }
      : null,
    values.customerId
      ? { key: "customerId", label: "客户", value: optionLabel(customerOptions, values.customerId) }
      : null,
    values.storeId
      ? { key: "storeId", label: "店铺", value: optionLabel(storeOptions, values.storeId) }
      : null,
    values.dateFrom
      ? { key: "dateFrom", label: "开始日期", value: values.dateFrom }
      : null,
    values.dateTo ? { key: "dateTo", label: "结束日期", value: values.dateTo } : null,
  ].filter((filter): filter is { key: string; label: string; value: string } => Boolean(filter));

  const commonFields = [
    "orderNumber",
    "status",
    ...(customerOptions.length ? ["customerId"] : []),
    ...(storeOptions.length ? ["storeId"] : []),
  ];

  return (
    <section
      aria-label="订单筛选"
      className={cn(
        "rounded-[var(--radius-surface)] bg-background p-4 sm:p-5",
        isCustomer ? "border border-transparent" : "border border-border",
      )}
      data-filter-audience={audience}
      data-portal-toolbar={isCustomer ? "" : undefined}
    >
      <form
        className={cn(
          "grid gap-3 sm:grid-cols-2",
          isCustomer
            ? "lg:grid-cols-[minmax(0,1.4fr)_minmax(11rem,0.75fr)_minmax(20rem,1.2fr)] lg:items-end"
            : "xl:grid-cols-[minmax(220px,1.2fr)_repeat(3,minmax(150px,0.8fr))_minmax(16rem,auto)] xl:items-end",
        )}
        onSubmit={(event) => applyFields(event, commonFields)}
      >
        <label className="space-y-2 text-sm font-medium text-ink" data-testid="common-order-filter">
          拿货单号
          <Input
            className="min-h-11"
            defaultValue={values.orderNumber}
            key={`order-number-${values.orderNumber ?? ""}`}
            name="orderNumber"
            placeholder="搜索完整或部分单号"
          />
        </label>
        <FilterSelect
          allLabel="全部状态"
          key={`status-${values.status ?? ""}`}
          label="状态"
          name="status"
          native={!isCustomer}
          options={statusOptions}
          value={values.status}
        />
        {customerOptions.length ? (
          <FilterSelect
            allLabel="全部客户"
            key={`customer-${values.customerId ?? ""}`}
            label="客户"
            name="customerId"
            native={!isCustomer}
            options={customerOptions}
            value={values.customerId}
          />
        ) : null}
        {storeOptions.length ? (
          <FilterSelect
            allLabel="全部店铺"
            key={`store-${values.storeId ?? ""}`}
            label="店铺"
            name="storeId"
            native={!isCustomer}
            options={storeOptions}
            value={values.storeId}
          />
        ) : null}
        <div
          className={cn(
            "space-y-2",
            isCustomer && "sm:col-span-2 lg:col-span-1",
          )}
          data-filter-action-wrapper
        >
          <div
            className={cn(
              "grid grid-cols-2 gap-2 rounded-[calc(var(--radius-control)+0.1rem)]",
              isCustomer
                ? "min-w-0"
                : "border border-border bg-surface/65 p-1.5",
            )}
            data-filter-action-group
          >
            <Button className="min-h-11 w-full" size="lg" type="submit">
              <Search aria-hidden="true" />
              筛选
            </Button>
            <Sheet onOpenChange={setDrawerOpen} open={drawerOpen}>
              <SheetTrigger asChild>
                <Button className="min-h-11 w-full bg-background" size="lg" type="button" variant="outline">
                  <Filter aria-hidden="true" />
                  更多筛选
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full data-[side=right]:!w-full sm:data-[side=right]:!max-w-[480px]" side="right">
                <SheetHeader className="border-b border-border px-5 py-4 pr-14">
                  <SheetTitle>更多订单筛选</SheetTitle>
                  <SheetDescription>按创建日期缩小结果范围；应用后条件会保留在当前网址。</SheetDescription>
                </SheetHeader>
                <form
                  className="grid gap-5 px-5 py-6"
                  onSubmit={(event) => {
                    applyFields(event, ["dateFrom", "dateTo"]);
                    setDrawerOpen(false);
                  }}
                >
                  <label className="space-y-2 text-sm font-medium text-ink">
                    开始日期
                    <Input
                      className="min-h-11"
                      defaultValue={values.dateFrom}
                      key={`date-from-${values.dateFrom ?? ""}`}
                      name="dateFrom"
                      type="date"
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium text-ink">
                    结束日期
                    <Input
                      className="min-h-11"
                      defaultValue={values.dateTo}
                      key={`date-to-${values.dateTo ?? ""}`}
                      name="dateTo"
                      type="date"
                    />
                  </label>
                  <Button className="min-h-11" type="submit">
                    应用更多筛选
                  </Button>
                </form>
              </SheetContent>
            </Sheet>
          </div>
          {isCustomer ? null : (
            <p className="text-xs leading-5 text-muted-foreground">
              常用条件先筛一轮，日期等扩展条件放在右侧抽屉，避免主工作区过宽过散。
            </p>
          )}
        </div>
      </form>

      {activeFilters.length ? (
        <div aria-label="已启用筛选" className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">已启用</span>
          {activeFilters.map((filter) => (
            <button
              aria-label={`移除筛选：${filter.label} ${filter.value}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm text-ink transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/22"
              key={filter.key}
              onClick={() => replaceParams((params) => params.delete(filter.key))}
              type="button"
            >
              <span>{`${filter.label}：${filter.value}`}</span>
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ))}
          <button
            className="min-h-11 px-2 text-sm font-medium text-primary-hover hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/22"
            onClick={() => router.replace(pathname, { scroll: false })}
            type="button"
          >
            清空全部
          </button>
        </div>
      ) : null}
    </section>
  );
}

export type { FilterOption, OrderFilterBarProps, OrderFilterValues };
