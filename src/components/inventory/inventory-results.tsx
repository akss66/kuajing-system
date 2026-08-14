import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ManagedAction } from "@/shared/action-state";

import { InventoryAdjustmentDrawer } from "./inventory-adjustment-drawer";
import type { InventoryWorkspaceRow } from "./inventory-workspace";
import { alertClassName, alertLabel } from "./inventory-overview";

export function InventoryResults({
  adjustInventoryAction,
  rows,
  setInventoryToActualCountAction,
}: {
  adjustInventoryAction: ManagedAction;
  rows: InventoryWorkspaceRow[];
  setInventoryToActualCountAction: ManagedAction;
}) {
  return (
    <>
      <div className="hidden min-w-0 xl:block" data-inventory-table>
        <Table aria-label="实时库存列表">
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead><TableHead>名称</TableHead><TableHead className="text-right">总库存</TableHead><TableHead className="text-right">订单锁定</TableHead><TableHead className="text-right">可售库存</TableHead><TableHead className="text-right">7 日出库</TableHead><TableHead className="text-right">覆盖天数</TableHead><TableHead>库存预警</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold tabular-nums">{row.skuCode}</TableCell>
                <TableCell><p className="max-w-64 break-words">{row.name}</p></TableCell>
                <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                <TableCell className="text-right tabular-nums">{row.locked}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{row.available}</TableCell>
                <TableCell className="text-right tabular-nums">{row.shippedQuantity7d}</TableCell>
                <TableCell className="text-right tabular-nums">{row.coverageDays == null ? "暂无基线" : `${row.coverageDays} 天`}</TableCell>
                <TableCell><Badge className={alertClassName(row.alertLevel)} variant="secondary">{alertLabel(row.alertLevel)}</Badge></TableCell>
                <TableCell className="text-right"><InventoryAdjustmentDrawer action={adjustInventoryAction} row={row} setActualAction={setInventoryToActualCountAction} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label="实时库存列表" className="space-y-3 xl:hidden" data-inventory-cards>
        {rows.map((row) => (
          <li className="min-w-0 rounded-[var(--radius-surface)] border border-border bg-background p-4" key={row.id}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0"><p className="truncate font-semibold tabular-nums text-foreground">{row.skuCode}</p><p className="mt-1 break-words text-sm text-muted-foreground">{row.name}</p></div>
              <Badge className={alertClassName(row.alertLevel)} variant="secondary">{alertLabel(row.alertLevel)}</Badge>
            </div>
            <dl className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border py-3">
              <div className="min-w-0 pr-2"><dt className="text-xs font-medium text-muted-foreground">可售库存</dt><dd className="mt-1 font-semibold tabular-nums text-foreground">{row.available}</dd></div>
              <div className="min-w-0 px-2"><dt className="text-xs font-medium text-muted-foreground">订单锁定</dt><dd className="mt-1 tabular-nums text-foreground">{row.locked}</dd></div>
              <div className="min-w-0 pl-2"><dt className="text-xs font-medium text-muted-foreground">总库存</dt><dd className="mt-1 tabular-nums text-foreground">{row.total}</dd></div>
            </dl>
            <p className="mt-3 text-xs tabular-nums text-muted-foreground">近 7 日出库 {row.shippedQuantity7d} 件 · {row.coverageDays == null ? "暂无消耗基线" : `预计可售 ${row.coverageDays} 天`}</p>
            <div className="mt-4"><InventoryAdjustmentDrawer action={adjustInventoryAction} row={row} setActualAction={setInventoryToActualCountAction} /></div>
          </li>
        ))}
      </ul>
    </>
  );
}
