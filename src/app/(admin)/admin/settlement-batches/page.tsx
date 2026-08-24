import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
import { SettlementRegion, SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAdminOrderFilterOptions } from "@/modules/orders/queries";
import {
  listAdminSettlementBatches,
  type AdminSettlementBatchFilters,
} from "@/modules/settlement/admin-queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const statusOptions = [
  { label: "待付款", value: "PENDING_PAYMENT" },
  { label: "等待统一核款", value: "PAYMENT_REPORTED" },
  { label: "已收款", value: "PAID" },
  { label: "已拒绝", value: "REJECTED" },
  { label: "已撤回", value: "WITHDRAWN" },
  { label: "已超时", value: "EXPIRED" },
];

function value(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function AdminSettlementBatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters: AdminSettlementBatchFilters = {
    customerId: value(raw.customerId),
    dateFrom: value(raw.dateFrom),
    dateTo: value(raw.dateTo),
    status: value(raw.status),
    storeId: value(raw.storeId),
  };

  const [batches, options] = await Promise.all([
    listAdminSettlementBatches(filters),
    listAdminOrderFilterOptions(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "批量付款审核" },
        ]}
        description="客户多店铺批量拿货会合并为一次付款；管理员只能整笔确认或整笔拒绝，不能拆分到账。"
        title="批量付款审核"
      />

      <MetricStrip
        items={[
          { label: "付款记录", value: `${batches.length}` },
          { label: "待审核", value: `${batches.filter((batch) => batch.statusLabel.includes("核款")).length}` },
          { label: "待付款", value: `${batches.filter((batch) => batch.statusLabel.includes("待付款")).length}` },
        ]}
      />

      <SettlementWorkspace>
        <WorkspacePanel className="p-4 sm:p-5">
          <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_0.8fr_0.8fr_auto_auto] xl:items-end">
          <label className="space-y-2 text-sm font-medium text-ink">
            客户
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              defaultValue={filters.customerId ?? ""}
              name="customerId"
            >
              <option value="">全部客户</option>
              {options.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.code}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            店铺
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              defaultValue={filters.storeId ?? ""}
              name="storeId"
            >
              <option value="">全部店铺</option>
              {options.stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            状态
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              defaultValue={filters.status ?? ""}
              name="status"
            >
              <option value="">全部状态</option>
              {statusOptions.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            开始日期
            <Input className="min-h-11" defaultValue={filters.dateFrom} name="dateFrom" type="date" />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            结束日期
            <Input className="min-h-11" defaultValue={filters.dateTo} name="dateTo" type="date" />
          </label>
          <Button className="min-h-11 px-4" type="submit">
            筛选
          </Button>
          <Button asChild className="min-h-11 px-4" variant="outline">
            <Link href="/admin/settlement-batches">清空</Link>
          </Button>
          </form>
        </WorkspacePanel>

        <SettlementRegion
          description={`当前条件共 ${batches.length} 条。`}
          kind="batches"
          title="批量付款记录"
        >
        <div className="hidden md:block">
          <ResponsiveDataTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>付款编号 / 客户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>金额分摊</TableHead>
                  <TableHead>申报 / 截止</TableHead>
                  <TableHead>订单数</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.length ? (
                  batches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell>
                        <p className="font-semibold text-ink">{batch.batchNumber}</p>
                        <p className="mt-1 text-xs text-muted">{`${batch.customerCode} · ${batch.customerName}`}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{batch.statusLabel}</Badge>
                      </TableCell>
                      <TableCell>
                        <p className="font-semibold tabular-nums text-ink">{`总额 ${money(batch.totalAmountFen)}`}</p>
                        <p className="mt-1 text-xs text-muted">{`余额 ${money(batch.walletAmountFen)} · 微信 ${money(batch.offlineAmountFen)}`}</p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-ink">{`申报 ${dateTime(batch.paymentReportedAt)}`}</p>
                        <p className="mt-1 text-xs text-muted">{`截止 ${dateTime(batch.paymentDueAt)}`}</p>
                      </TableCell>
                      <TableCell className="tabular-nums">{batch.orderCount}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/settlement-batches/${batch.id}`}>查看核款</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell className="h-28 text-center text-muted" colSpan={6}>
                      没有符合条件的批量付款记录。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ResponsiveDataTable>
        </div>
        <div className="divide-y divide-border md:hidden">
          {batches.length ? (
            batches.map((batch) => (
              <article className="space-y-3 p-4" key={batch.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-ink">{batch.batchNumber}</p>
                    <p className="mt-1 text-xs text-muted">{batch.customerCode}</p>
                  </div>
                  <Badge variant="secondary">{batch.statusLabel}</Badge>
                </div>
                <p className="text-sm text-muted">{`总额 ${money(batch.totalAmountFen)} · 余额 ${money(batch.walletAmountFen)} · 微信 ${money(batch.offlineAmountFen)}`}</p>
                <p className="text-xs text-muted">{`申报 ${dateTime(batch.paymentReportedAt)} · 截止 ${dateTime(batch.paymentDueAt)}`}</p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/settlement-batches/${batch.id}`}>查看核款</Link>
                </Button>
              </article>
            ))
          ) : (
            <div className="p-10 text-center text-sm text-muted">没有符合条件的批量付款记录。</div>
          )}
        </div>
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
