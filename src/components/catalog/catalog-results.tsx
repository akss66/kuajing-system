import { ExternalLink, ImageIcon } from "lucide-react";
import Image from "next/image";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CatalogProductGroup } from "@/modules/catalog/product-groups";
import { formatMilliYuan } from "@/modules/catalog/unit-price";

import type { CatalogRow } from "./catalog-workspace";
import type { CatalogWorkspaceProps } from "./catalog-workspace";
import { ManageSkuDrawer } from "./catalog-mutation-drawers";

type CatalogGroup = CatalogProductGroup<CatalogRow>;

function saleStatusLabel(status: CatalogRow["saleStatus"]) {
  return status === "SELLABLE" ? "可售" : "不可售";
}

function saleStatusClassName(status: CatalogRow["saleStatus"]) {
  return status === "SELLABLE"
    ? "bg-success/10 text-success"
    : "bg-secondary text-secondary-foreground";
}

function CatalogImage({ row }: { row: CatalogRow }) {
  if (row.imageUrl) {
    return (
      <Image
        alt={`${row.productName} 商品图片`}
        className="size-12 shrink-0 rounded-[var(--radius-control)] border border-border object-cover"
        height={48}
        sizes="48px"
        src={row.imageUrl}
        unoptimized
        width={48}
      />
    );
  }

  return (
    <span
      aria-label={`${row.productName} 图片缺失`}
      className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface text-muted-foreground"
      role="img"
    >
      <ImageIcon aria-hidden="true" className="size-4" />
    </span>
  );
}

function CatalogSkuIdentity({ row }: { row: CatalogRow }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <CatalogImage row={row} />
      <p className="min-w-0 break-words pt-1 text-sm font-semibold tabular-nums text-foreground">
        {row.skuCode}
      </p>
    </div>
  );
}

function CatalogAttributes({ row }: { row: CatalogRow }) {
  const attributes = [
    row.color ? `颜色：${row.color}` : null,
    row.combination ? `组合销售：${row.combination}` : null,
    row.weightGrams !== null ? `重量：${row.weightGrams} 克` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="min-w-0">
      <p
        className="line-clamp-2 whitespace-normal break-words leading-5 text-foreground"
        title={row.specification ?? undefined}
      >
        {row.specification ?? "规格未提供"}
      </p>
      {attributes.length > 0 ? (
        <ul aria-label={`${row.skuCode} 属性`} className="mt-1 space-y-0.5">
          {attributes.map((attribute) => (
            <li
              className="whitespace-normal break-words text-xs leading-4 text-muted-foreground"
              key={attribute}
            >
              {attribute}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function safeAbsoluteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function CatalogProductLink({ row }: { row: CatalogRow }) {
  if (!row.productUrl) {
    return <span className="text-sm text-muted-foreground">暂无链接</span>;
  }

  const safeUrl = safeAbsoluteHttpUrl(row.productUrl);
  if (!safeUrl) {
    return <span className="text-sm text-muted-foreground">链接不可用</span>;
  }

  return (
    <a
      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 whitespace-normal break-words text-sm font-medium text-primary underline-offset-4 hover:underline xl:min-h-0"
      href={safeUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="line-clamp-2">{row.linkText?.trim() || "查看商品"}</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );
}

function CatalogStatus({ row }: { row: CatalogRow }) {
  return (
    <Badge className={saleStatusClassName(row.saleStatus)} variant="secondary">
      {saleStatusLabel(row.saleStatus)}
    </Badge>
  );
}

function PriceValue({ value }: { value: number | null }) {
  return value === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span>{formatMilliYuan(value)}</span>
  );
}

type CatalogResultsProps = {
  actions: CatalogWorkspaceProps["actions"];
  groups: CatalogGroup[];
  onSelectionChange: (selectedIds: Set<string>) => void;
  selectedIds: Set<string>;
};

function selectionToggle(selectedIds: Set<string>, id: string, checked: boolean) {
  const next = new Set(selectedIds);
  if (checked) next.add(id); else next.delete(id);
  return next;
}

function CatalogTable({ actions, groups, onSelectionChange, selectedIds }: CatalogResultsProps) {
  const visibleIds = groups.flatMap((group) => group.variants.map((row) => row.id));
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  return (
    <div className="hidden min-w-0 xl:block" data-admin-catalog-table>
      <Table aria-label="商品与 SKU 列表" className="w-full table-fixed">
        <colgroup>
          <col className="w-[3%]" />
          <col className="w-[6%]" />
          <col className="w-[10%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[8%]" />
          <col className="w-[7%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[7%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead><input aria-label="选择当前结果全部 SKU" checked={allSelected} onChange={(event) => onSelectionChange(event.target.checked ? new Set([...selectedIds, ...visibleIds]) : new Set([...selectedIds].filter((id) => !visibleIds.includes(id))))} type="checkbox" /></TableHead>
            <TableHead className="text-right">序号</TableHead>
            <TableHead>商品</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>规格/属性</TableHead>
            <TableHead className="text-right">采购价</TableHead>
            <TableHead className="text-right">总库存</TableHead>
            <TableHead className="text-right">可售库存</TableHead>
            <TableHead className="text-right">货品价格</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>SKU 链接</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.flatMap((group) =>
            group.variants.map((row, index) => (
              <TableRow
                className={index === 0 ? "border-t-2 border-border" : undefined}
                key={row.id}
              >
                <TableCell className="align-top"><input aria-label={`选择 ${row.skuCode}`} checked={selectedIds.has(row.id)} onChange={(event) => onSelectionChange(selectionToggle(selectedIds, row.id, event.target.checked))} type="checkbox" /></TableCell>
                {index === 0 ? (
                  <TableCell
                    className="whitespace-normal text-right align-top font-semibold tabular-nums"
                    rowSpan={group.variants.length}
                  >
                    {group.sourceSequence === null ? "—" : `序号 ${group.sourceSequence}`}
                  </TableCell>
                ) : null}
                {index === 0 ? (
                  <TableCell
                    className="min-w-0 whitespace-normal align-top font-medium text-foreground"
                    rowSpan={group.variants.length}
                  >
                    <p className="line-clamp-3 break-words">{group.productName}</p>
                  </TableCell>
                ) : null}
                <TableCell className="min-w-0 whitespace-normal align-top">
                  <CatalogSkuIdentity row={row} />
                </TableCell>
                <TableCell className="min-w-0 whitespace-normal align-top">
                  <CatalogAttributes row={row} />
                </TableCell>
                <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                  <PriceValue value={row.defaultUnitPriceMilliYuan} />
                </TableCell>
                <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                  {row.totalQuantity}
                </TableCell>
                <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                  {row.availableQuantity}
                </TableCell>
                {index === 0 ? (
                  <TableCell
                    className="whitespace-normal text-right align-top font-semibold tabular-nums"
                    rowSpan={group.variants.length}
                  >
                    <PriceValue value={group.variants[0]!.cargoUnitPriceMilliYuan} />
                  </TableCell>
                ) : null}
                <TableCell className="whitespace-normal align-top">
                  <CatalogStatus row={row} />
                </TableCell>
                <TableCell className="min-w-0 whitespace-normal align-top">
                  <CatalogProductLink row={row} />
                </TableCell>
                <TableCell className="whitespace-normal align-top"><ManageSkuDrawer actions={actions} groupSize={group.variants.length} row={row} /></TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function CatalogCards({ actions, groups, onSelectionChange, selectedIds }: CatalogResultsProps) {
  return (
    <ul
      aria-label="商品与 SKU 卡片列表"
      className="space-y-3 xl:hidden"
      data-admin-catalog-cards
    >
      {groups.map((group) => (
        <li
          className="min-w-0 rounded-[var(--radius-surface)] border border-border bg-background p-4"
          key={group.productId}
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="line-clamp-2 break-words font-medium text-foreground">
                {group.productName}
              </p>
              <p className="mt-1 text-xs font-semibold tabular-nums text-muted-foreground">
                来源序号 {group.sourceSequence ?? "—"}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs font-medium text-muted-foreground">货品价格</p>
              <p className="mt-1 font-semibold tabular-nums text-foreground">
                <PriceValue value={group.variants[0]!.cargoUnitPriceMilliYuan} />
              </p>
            </div>
          </div>

          <ul
            aria-label={`${group.productName} 的 SKU 列表`}
            className="mt-4 space-y-3 border-t border-border pt-3"
          >
            {group.variants.map((row) => (
              <li className="min-w-0 border-b border-border/70 pb-3 last:border-b-0 last:pb-0" key={row.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <label className="flex min-h-11 min-w-0 items-start gap-3"><input aria-label={`选择 ${row.skuCode}`} checked={selectedIds.has(row.id)} className="mt-4" onChange={(event) => onSelectionChange(selectionToggle(selectedIds, row.id, event.target.checked))} type="checkbox" /><CatalogSkuIdentity row={row} /></label>
                  <div className="flex flex-col items-end gap-2"><CatalogStatus row={row} /><ManageSkuDrawer actions={actions} groupSize={group.variants.length} row={row} /></div>
                </div>

                <div className="mt-3" data-catalog-section="attributes">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">规格/属性</p>
                  <CatalogAttributes row={row} />
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-4 border-t border-border/70 pt-3">
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">采购价</dt>
                    <dd className="mt-1 font-semibold tabular-nums text-foreground">
                      <PriceValue value={row.defaultUnitPriceMilliYuan} />
                    </dd>
                  </div>
                  <div className="text-right">
                    <dt className="text-xs font-medium text-muted-foreground">库存</dt>
                    <dd className="mt-1 font-semibold tabular-nums text-foreground">
                      {row.totalQuantity} / {row.availableQuantity}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex min-h-11 items-center justify-between gap-3 border-t border-border/70 pt-3">
                  <span className="text-xs font-medium text-muted-foreground">SKU 链接</span>
                  <CatalogProductLink row={row} />
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function CatalogResults(props: CatalogResultsProps) {
  return (
    <>
      <CatalogTable {...props} />
      <CatalogCards {...props} />
    </>
  );
}
