import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { CatalogRow } from "./catalog-workspace";
import { formatMilliYuan } from "@/modules/catalog/unit-price";

function saleStatusLabel(status: string) {
  return status === "SELLABLE" ? "可售" : "不可售";
}

function saleStatusClassName(status: string) {
  return status === "SELLABLE"
    ? "bg-success/10 text-success"
    : "bg-secondary text-secondary-foreground";
}

export function CatalogResults({ rows }: { rows: CatalogRow[] }) {
  return (
    <>
      <div className="hidden lg:block" data-admin-catalog-table>
        <Table aria-label="商品与 SKU 列表" className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>商品</TableHead>
              <TableHead>规格名称</TableHead>
              <TableHead className="text-right">统一拿货价</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold tabular-nums">{row.skuCode}</TableCell>
                <TableCell>{row.productName}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatMilliYuan(row.priceMilliYuan)}</TableCell>
                <TableCell>
                  <Badge className={saleStatusClassName(row.saleStatus)} variant="secondary">
                    {saleStatusLabel(row.saleStatus)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul aria-label="商品与 SKU 列表" className="space-y-3 lg:hidden" data-admin-catalog-cards>
        {rows.map((row) => (
          <li className="rounded-[var(--radius-surface)] border border-border bg-background p-4" key={row.id}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold tabular-nums text-foreground">{row.skuCode}</p>
                <p className="mt-1 text-sm text-foreground">{row.productName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{row.name}</p>
              </div>
              <Badge className={saleStatusClassName(row.saleStatus)} variant="secondary">
                {saleStatusLabel(row.saleStatus)}
              </Badge>
            </div>
            <dl className="mt-4 border-t border-border pt-3">
              <dt className="text-xs font-medium text-muted-foreground">统一拿货价</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-foreground">{formatMilliYuan(row.priceMilliYuan)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
