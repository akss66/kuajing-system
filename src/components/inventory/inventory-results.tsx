import { ArrowDown, ArrowUp, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import type { InventoryWorkspaceRow, RecentInventoryMovement } from "./inventory-workspace";
import { alertClassName, alertLabel } from "./inventory-overview";

const movementTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Toronto",
});

function movementLabel(type: RecentInventoryMovement["movementType"]) {
  if (type === "MANUAL_INCREASE") return "手动增加";
  if (type === "MANUAL_DECREASE") return "手动减少";
  if (type === "SHIPMENT") return "发货扣减";
  return "库存冲正";
}

export function InventoryResults({ rows }: { rows: InventoryWorkspaceRow[] }) {
  return (
    <>
      <div className="hidden lg:block" data-inventory-table>
        <Table aria-label="实时库存列表" className="min-w-[940px]">
          <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>名称</TableHead><TableHead className="text-right">总库存</TableHead><TableHead className="text-right">订单锁定</TableHead><TableHead className="text-right">可售库存</TableHead><TableHead className="text-right">7 日出库</TableHead><TableHead className="text-right">覆盖天数</TableHead><TableHead>库存预警</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold tabular-nums">{row.skuCode}</TableCell><TableCell>{row.name}</TableCell><TableCell className="text-right tabular-nums">{row.total}</TableCell><TableCell className="text-right tabular-nums">{row.locked}</TableCell><TableCell className="text-right font-semibold tabular-nums">{row.available}</TableCell><TableCell className="text-right tabular-nums">{row.shippedQuantity7d}</TableCell><TableCell className="text-right tabular-nums">{row.coverageDays == null ? "暂无基线" : `${row.coverageDays} 天`}</TableCell><TableCell><Badge className={alertClassName(row.alertLevel)} variant="secondary">{alertLabel(row.alertLevel)}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label="实时库存列表" className="space-y-3 lg:hidden" data-inventory-cards>
        {rows.map((row) => (
          <li className="rounded-[var(--radius-surface)] border border-border bg-background p-4" key={row.id}>
            <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold tabular-nums text-foreground">{row.skuCode}</p><p className="mt-1 text-sm text-muted-foreground">{row.name}</p></div><Badge className={alertClassName(row.alertLevel)} variant="secondary">{alertLabel(row.alertLevel)}</Badge></div>
            <dl className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border py-3">
              <div className="min-w-0 pr-2"><dt className="text-xs font-medium text-muted-foreground">可售库存</dt><dd className="mt-1 font-semibold tabular-nums text-foreground">{row.available}</dd></div><div className="min-w-0 px-2"><dt className="text-xs font-medium text-muted-foreground">订单锁定</dt><dd className="mt-1 tabular-nums text-foreground">{row.locked}</dd></div><div className="min-w-0 pl-2"><dt className="text-xs font-medium text-muted-foreground">总库存</dt><dd className="mt-1 tabular-nums text-foreground">{row.total}</dd></div>
            </dl>
            <p className="mt-3 text-xs tabular-nums text-muted-foreground">近 7 日出库 {row.shippedQuantity7d} 件 · {row.coverageDays == null ? "暂无消耗基线" : `预计可售 ${row.coverageDays} 天`}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function RecentMovements({ movements }: { movements: RecentInventoryMovement[] }) {
  return (
    <section aria-label="最近库存变动" className="space-y-3">
      <div><h2 className="flex items-center gap-2 text-base font-semibold text-foreground"><History aria-hidden="true" className="size-4 text-muted-foreground" />最近库存变动</h2><p className="mt-1 text-sm text-muted-foreground">最近的入库、扣减和冲正记录，用于核对库存变化原因。</p></div>
      {movements.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border">
          {movements.map((movement) => (
            <li className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={movement.id}>
              <div className="min-w-0"><p className="flex min-w-0 items-center gap-2 font-medium text-foreground">{movement.delta > 0 ? <ArrowUp aria-hidden="true" className="size-4 shrink-0 text-success" /> : <ArrowDown aria-hidden="true" className="size-4 shrink-0 text-warning" />}<span className="truncate tabular-nums">{movement.skuCode}</span><span className={movement.delta > 0 ? "tabular-nums text-success" : "tabular-nums text-warning"}>{movement.delta > 0 ? "+" : ""}{movement.delta}</span></p><p className="mt-1 text-sm text-muted-foreground">{movementLabel(movement.movementType)} · {movement.reason}</p></div>
              <div className="text-sm tabular-nums text-muted-foreground sm:text-right"><p>调整后 {movement.afterQuantity}</p><time dateTime={movement.createdAt}>{movementTimeFormatter.format(new Date(movement.createdAt))}</time></div>
            </li>
          ))}
        </ul>
      ) : <p className="border-y border-border py-5 text-sm text-muted-foreground" role="status">暂无库存变动记录。</p>}
    </section>
  );
}
