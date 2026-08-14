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
import { formatMilliYuan } from "@/modules/catalog/unit-price";

import type { CatalogRow } from "./catalog-workspace";

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

function CatalogProductIdentity({ row }: { row: CatalogRow }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <CatalogImage row={row} />
      <div className="min-w-0">
        <p className="line-clamp-2 whitespace-normal break-words font-medium text-foreground">
          {row.productName}
        </p>
        <p className="mt-1 truncate text-xs font-semibold tabular-nums text-muted-foreground">
          {row.skuCode}
        </p>
      </div>
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

function CatalogTable({ rows }: { rows: CatalogRow[] }) {
  return (
    <div className="hidden min-w-0 xl:block" data-admin-catalog-table>
      <Table aria-label="商品与 SKU 列表" className="w-full table-fixed">
        <colgroup>
          <col className="w-[6%]" />
          <col className="w-[22%]" />
          <col className="w-[20%]" />
          <col className="w-[8%]" />
          <col className="w-[8%]" />
          <col className="w-[8%]" />
          <col className="w-[9%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead className="text-right">序号</TableHead>
            <TableHead>商品</TableHead>
            <TableHead>规格/属性</TableHead>
            <TableHead className="text-right">采购价</TableHead>
            <TableHead className="text-right">总库存</TableHead>
            <TableHead className="text-right">可售库存</TableHead>
            <TableHead className="text-right">货品价格</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>链接</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                {row.sourceSequence ?? "—"}
              </TableCell>
              <TableCell className="min-w-0 whitespace-normal align-top">
                <CatalogProductIdentity row={row} />
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
              <TableCell className="whitespace-normal text-right align-top font-semibold tabular-nums">
                <PriceValue value={row.cargoUnitPriceMilliYuan} />
              </TableCell>
              <TableCell className="whitespace-normal align-top">
                <CatalogStatus row={row} />
              </TableCell>
              <TableCell className="min-w-0 whitespace-normal align-top">
                <CatalogProductLink row={row} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CatalogCards({ rows }: { rows: CatalogRow[] }) {
  return (
    <ul
      aria-label="商品与 SKU 卡片列表"
      className="space-y-3 xl:hidden"
      data-admin-catalog-cards
    >
      {rows.map((row) => (
        <li
          className="min-w-0 rounded-[var(--radius-surface)] border border-border bg-background p-4"
          key={row.id}
        >
          <div
            className="flex min-w-0 items-start justify-between gap-3"
            data-catalog-section="identity"
          >
            <CatalogProductIdentity row={row} />
            <p className="shrink-0 text-right text-xs text-muted-foreground">
              序号
              <span className="mt-0.5 block font-semibold tabular-nums text-foreground">
                {row.sourceSequence ?? "—"}
              </span>
            </p>
          </div>

          <div
            className="mt-4 border-t border-border pt-3"
            data-catalog-section="attributes"
          >
            <p className="mb-1 text-xs font-medium text-muted-foreground">规格/属性</p>
            <CatalogAttributes row={row} />
          </div>

          <dl
            className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-3"
            data-catalog-section="prices"
          >
            <div>
              <dt className="text-xs font-medium text-muted-foreground">采购价</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                <PriceValue value={row.defaultUnitPriceMilliYuan} />
              </dd>
            </div>
            <div className="text-right">
              <dt className="text-xs font-medium text-muted-foreground">货品价格</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                <PriceValue value={row.cargoUnitPriceMilliYuan} />
              </dd>
            </div>
          </dl>

          <dl
            className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-3"
            data-catalog-section="inventory"
          >
            <div>
              <dt className="text-xs font-medium text-muted-foreground">总库存</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                {row.totalQuantity}
              </dd>
            </div>
            <div className="text-right">
              <dt className="text-xs font-medium text-muted-foreground">可售库存</dt>
              <dd className="mt-1 font-semibold tabular-nums text-foreground">
                {row.availableQuantity}
              </dd>
            </div>
          </dl>

          <div
            className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3"
            data-catalog-section="status"
          >
            <span className="text-xs font-medium text-muted-foreground">状态</span>
            <CatalogStatus row={row} />
          </div>

          <div
            className="mt-3 flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3"
            data-catalog-section="link"
          >
            <span className="text-xs font-medium text-muted-foreground">链接</span>
            <CatalogProductLink row={row} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CatalogResults({ rows }: { rows: CatalogRow[] }) {
  return (
    <>
      <CatalogTable rows={rows} />
      <CatalogCards rows={rows} />
    </>
  );
}
