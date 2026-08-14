import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  InventoryMovementPage,
  InventoryMovementSource,
} from "@/modules/inventory/read-model";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export type SerializableInventoryMovementPage = Omit<InventoryMovementPage, "rows"> & {
  rows: Array<Omit<InventoryMovementPage["rows"][number], "createdAt"> & { createdAt: string }>;
};

export type InventoryMovementFilterValues = {
  actorId?: string;
  from?: string;
  movementType?: string;
  skuCode?: string;
  source?: InventoryMovementSource;
  to?: string;
};

const movementTypes = [
  ["MANUAL_INCREASE", "手动增加"],
  ["MANUAL_DECREASE", "手动减少"],
  ["SHIPMENT", "发货扣减"],
  ["REVERSAL", "库存冲正"],
] as const;

const sources = [
  ["SYSTEM_ORDER_SHIPMENT", "系统订单自动发货"],
  ["ADMIN_OFFLINE_FULFILLMENT", "线下发货/人工出库"],
  ["ADMIN_ADJUSTMENT", "管理员调整"],
  ["STOCKTAKE", "盘点"],
  ["FEISHU_MIGRATION", "飞书迁移"],
  ["SYSTEM_REVERSAL", "系统冲正"],
] as const satisfies readonly (readonly [InventoryMovementSource, string])[];

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: BUSINESS_TIME_ZONE,
});

function sourceLabel(source: InventoryMovementSource) {
  return sources.find(([value]) => value === source)?.[1] ?? source;
}

function movementHref(filters: InventoryMovementFilterValues, page: number) {
  const query = new URLSearchParams({ view: "movements" });
  if (filters.skuCode) query.set("sku", filters.skuCode);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.movementType) query.set("type", filters.movementType);
  if (filters.actorId) query.set("operator", filters.actorId);
  if (filters.source) query.set("source", filters.source);
  if (page > 1) query.set("page", String(page));
  return `/admin/inventory?${query.toString()}`;
}

function Relation({ relation }: { relation: SerializableInventoryMovementPage["rows"][number]["relation"] }) {
  if (!relation) return <span className="text-muted-foreground">无</span>;
  if (relation.href) {
    return (
      <Link className="font-medium text-primary underline-offset-4 hover:underline" href={relation.href}>
        {relation.label}
      </Link>
    );
  }
  return <span>{relation.label}</span>;
}

export function InventoryMovementsView({
  filters,
  movementPage,
}: {
  filters: InventoryMovementFilterValues;
  movementPage: SerializableInventoryMovementPage;
}) {
  return (
    <section aria-label="库存流水" className="min-w-0 space-y-5">
      <form
        aria-label="筛选库存流水"
        className="grid gap-3 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-6"
        key={movementHref(filters, 1)}
        method="get"
        role="search"
      >
        <input name="view" type="hidden" value="movements" />
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          SKU
          <Input className="min-h-11" defaultValue={filters.skuCode} name="sku" placeholder="输入完整 SKU" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          开始时间
          <Input className="min-h-11" defaultValue={filters.from} name="from" type="date" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          结束时间
          <Input className="min-h-11" defaultValue={filters.to} name="to" type="date" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          流水类型
          <select className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm" defaultValue={filters.movementType ?? ""} name="type">
            <option value="">全部类型</option>
            {movementTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          操作人
          <Input className="min-h-11" defaultValue={filters.actorId} name="operator" placeholder="输入操作人账号 ID" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          来源
          <select className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm" defaultValue={filters.source ?? ""} name="source">
            <option value="">全部来源</option>
            {sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="flex gap-2 sm:col-span-2 xl:col-span-6 xl:justify-end">
          <Button className="min-h-11" type="submit">应用筛选</Button>
          <Button asChild className="min-h-11" variant="outline">
            <Link href="/admin/inventory?view=movements">重置筛选</Link>
          </Button>
        </div>
      </form>

      {movementPage.rows.length ? (
        <>
          <div className="hidden min-w-0 xl:block" data-inventory-movement-table>
            <Table aria-label="库存流水列表" className="table-fixed">
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[7%]" />
                <col className="w-[7%]" />
                <col className="w-[7%]" />
                <col className="w-[21%]" />
                <col className="w-[12%]" />
                <col className="w-[13%]" />
                <col className="w-[12%]" />
                <col className="w-[9%]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead><TableHead className="text-right">前值</TableHead><TableHead className="text-right">变动</TableHead><TableHead className="text-right">后值</TableHead><TableHead>原因与备注</TableHead><TableHead>操作人</TableHead><TableHead>来源</TableHead><TableHead>时间</TableHead><TableHead>关联单据</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movementPage.rows.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"><span className="font-semibold tabular-nums">{movement.skuCode}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{movement.beforeQuantity}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{movement.delta > 0 ? "+" : ""}{movement.delta}</TableCell>
                    <TableCell className="text-right tabular-nums">{movement.afterQuantity}</TableCell>
                    <TableCell className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"><p>{movement.reasonLabel}</p>{movement.remark ? <p className="mt-1 text-xs text-muted-foreground">{movement.remark}</p> : null}</TableCell>
                    <TableCell className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{movement.operator.label}</TableCell>
                    <TableCell className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{sourceLabel(movement.source)}</TableCell>
                    <TableCell><time className="whitespace-nowrap tabular-nums" dateTime={movement.createdAt}>{timeFormatter.format(new Date(movement.createdAt))}</time></TableCell>
                    <TableCell className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"><Relation relation={movement.relation} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul aria-label="库存流水列表" className="space-y-3 xl:hidden" data-inventory-movement-cards>
            {movementPage.rows.map((movement) => (
              <li className="min-w-0 rounded-[var(--radius-surface)] border border-border bg-background p-4" key={movement.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate font-semibold tabular-nums text-foreground">{movement.skuCode}</p><p className="mt-1 text-sm font-medium text-foreground">{movement.reasonLabel}</p></div>
                  <span className="shrink-0 rounded-[var(--radius-control)] bg-surface-muted px-2 py-1 text-xs font-medium text-foreground">{sourceLabel(movement.source)}</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border py-3 text-sm">
                  <div className="pr-2"><dt className="text-xs text-muted-foreground">前值</dt><dd className="mt-1 tabular-nums">{movement.beforeQuantity}</dd></div>
                  <div className="px-2"><dt className="text-xs text-muted-foreground">变动</dt><dd className="mt-1 font-semibold tabular-nums">{movement.delta > 0 ? "+" : ""}{movement.delta}</dd></div>
                  <div className="pl-2"><dt className="text-xs text-muted-foreground">后值</dt><dd className="mt-1 tabular-nums">{movement.afterQuantity}</dd></div>
                </dl>
                {movement.remark ? <p className="mt-3 break-words text-sm text-muted-foreground">{movement.remark}</p> : null}
                <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <p>操作人：{movement.operator.label}</p>
                  <time dateTime={movement.createdAt}>{timeFormatter.format(new Date(movement.createdAt))}</time>
                  <div className="sm:col-span-2">关联：<Relation relation={movement.relation} /></div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="border-y border-border py-10 text-center text-sm text-muted-foreground" role="status">没有符合条件的库存流水。</p>
      )}

      <nav aria-label="库存流水分页" className="flex items-center justify-between gap-3 border-t border-border pt-4">
        {movementPage.page <= 1 ? (
          <Button className="min-h-11" disabled type="button" variant="outline">上一页</Button>
        ) : (
          <Button asChild className="min-h-11" variant="outline"><Link href={movementHref(filters, movementPage.page - 1)}>上一页</Link></Button>
        )}
        <p className="text-sm tabular-nums text-muted-foreground">第 {movementPage.page} / {Math.max(1, movementPage.totalPages)} 页 · 共 {movementPage.total} 条</p>
        {movementPage.page >= movementPage.totalPages ? (
          <Button className="min-h-11" disabled type="button" variant="outline">下一页</Button>
        ) : (
          <Button asChild className="min-h-11" variant="outline"><Link href={movementHref(filters, movementPage.page + 1)}>下一页</Link></Button>
        )}
      </nav>
    </section>
  );
}
