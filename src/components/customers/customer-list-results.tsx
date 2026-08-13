import { CircleAlert } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CustomerManagementListRow } from "@/modules/customers/queries";

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  currency: "CNY",
  minimumFractionDigits: 2,
  style: "currency",
});

function money(fen: number) {
  return moneyFormatter.format(fen / 100);
}

function customerStatusLabel(status: CustomerManagementListRow["status"]) {
  return status === "ACTIVE" ? "启用中" : "已停用";
}

function customerStatusTone(status: CustomerManagementListRow["status"]) {
  return status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
}

function accountStatusLabel(status: CustomerManagementListRow["accountStatus"]) {
  if (status === "ACTIVE") return "账号正常";
  if (status === "DISABLED") return "账号已停用";
  return "账号待同步";
}

function exceptionLabel(count: number) {
  return count > 0 ? `${count} 单异常` : "无异常";
}

function CustomerDesktopTable({ rows }: { rows: CustomerManagementListRow[] }) {
  return (
    <div className="hidden lg:block" data-customer-table>
      <Table aria-label="客户列表" className="min-w-[980px]">
        <TableHeader>
          <TableRow>
            <TableHead>客户</TableHead>
            <TableHead>唯一登录账号</TableHead>
            <TableHead className="text-right">店铺数</TableHead>
            <TableHead className="text-right">余额</TableHead>
            <TableHead className="text-right">待付款</TableHead>
            <TableHead className="text-right">近 30 天订单</TableHead>
            <TableHead>异常</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow className="relative" key={row.customerId}>
              <TableCell>
                <Link
                  aria-label={`查看 ${row.name} 详情`}
                  className="font-medium text-foreground outline-none after:absolute after:inset-0 after:z-10 focus-visible:after:ring-3 focus-visible:after:ring-ring/22"
                  href={`/admin/customers/${row.customerId}`}
                >
                  {row.name}
                </Link>
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{row.code}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm text-foreground">{row.accountDisplayName ?? "待同步"}</p>
                <p className="mt-0.5 max-w-48 truncate text-xs text-muted-foreground">
                  {row.accountEmail ?? accountStatusLabel(row.accountStatus)}
                </p>
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.storeCount} 家</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{money(row.balanceFen)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(row.pendingPaymentFen)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.recentOrderCount} 单</TableCell>
              <TableCell>
                <Badge
                  className={
                    row.exceptionOrderCount > 0
                      ? "bg-destructive/10 text-destructive"
                      : "bg-secondary text-secondary-foreground"
                  }
                  variant="secondary"
                >
                  {row.exceptionOrderCount > 0 ? <CircleAlert aria-hidden="true" /> : null}
                  {exceptionLabel(row.exceptionOrderCount)}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge className={customerStatusTone(row.status)} variant="secondary">
                  {customerStatusLabel(row.status)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MobileFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function CustomerMobileCards({ rows }: { rows: CustomerManagementListRow[] }) {
  return (
    <ul aria-label="客户列表" className="space-y-3 lg:hidden" data-customer-cards>
      {rows.map((row) => (
        <li key={row.customerId}>
          <Link
            aria-label={`查看 ${row.name} 详情`}
            className="block min-h-11 rounded-[var(--radius-surface)] border border-border bg-background p-4 outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/22"
            href={`/admin/customers/${row.customerId}`}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">{row.name}</p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">{row.code}</p>
              </div>
              <Badge className={customerStatusTone(row.status)} variant="secondary">
                {customerStatusLabel(row.status)}
              </Badge>
            </div>

            <div className="mt-4 border-y border-border py-3">
              <p className="text-xs font-medium text-muted-foreground">唯一登录账号</p>
              <p className="mt-1 truncate text-sm text-foreground">
                {row.accountDisplayName ?? "待同步"}
              </p>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">
                {row.accountEmail ?? accountStatusLabel(row.accountStatus)}
              </p>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              <MobileFact label="店铺数" value={`${row.storeCount} 家`} />
              <MobileFact label="余额" value={money(row.balanceFen)} />
              <MobileFact label="待付款" value={money(row.pendingPaymentFen)} />
              <MobileFact label="近 30 天订单" value={`${row.recentOrderCount} 单`} />
            </dl>

            <p
              className={
                row.exceptionOrderCount > 0
                  ? "mt-3 flex items-center gap-1.5 text-sm font-medium text-destructive"
                  : "mt-3 text-sm text-muted-foreground"
              }
            >
              {row.exceptionOrderCount > 0 ? <CircleAlert aria-hidden="true" className="size-4" /> : null}
              {exceptionLabel(row.exceptionOrderCount)}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CustomerListResults({ rows }: { rows: CustomerManagementListRow[] }) {
  return (
    <>
      <CustomerDesktopTable rows={rows} />
      <CustomerMobileCards rows={rows} />
    </>
  );
}
