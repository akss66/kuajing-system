import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAdminOrderFilterOptions } from "@/modules/orders/queries";
import {
  listAdminBulkDrafts,
  type AdminBulkDraftFilters,
} from "@/modules/bulk-order/admin-queries";

const statusOptions = [
  { label: "可提交", value: "SUBMITTABLE" },
  { label: "跨店冲突", value: "BLOCKED_CROSS_STORE" },
  { label: "未知 SKU", value: "BLOCKED_UNKNOWN_SKU" },
  { label: "格式问题", value: "BLOCKED_INVALID" },
  { label: "库存变化", value: "BLOCKED_INVENTORY" },
  { label: "已提交", value: "ALREADY_SUBMITTED" },
  { label: "已过期", value: "EXPIRED" },
];

function value(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

export default async function AdminBulkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters: AdminBulkDraftFilters = {
    customerId: value(raw.customerId),
    dateFrom: value(raw.dateFrom),
    dateTo: value(raw.dateTo),
    status: value(raw.status) as AdminBulkDraftFilters["status"],
    storeId: value(raw.storeId),
  };

  const [drafts, options] = await Promise.all([
    listAdminBulkDrafts(filters),
    listAdminOrderFilterOptions(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "批量草稿诊断" },
        ]}
        description="按客户、店铺、状态和时间筛选多店铺批量草稿。这里只读展示文件摘要、冲突、错误码和部分提交结果。"
        title="批量草稿诊断"
      />

      <MetricStrip
        items={[
          { label: "草稿数", value: `${drafts.length}` },
          { label: "可提交", value: `${drafts.filter((draft) => draft.statusLabel.includes("可")).length}` },
          { label: "已过期", value: `${drafts.filter((draft) => draft.statusLabel.includes("过期")).length}` },
        ]}
      />

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
            诊断状态
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
            <Link href="/admin/bulk-orders">清空</Link>
          </Button>
        </form>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description={`当前条件共 ${drafts.length} 条。`}
          title="草稿列表"
        />
        <div className="hidden md:block">
          <ResponsiveDataTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户 / 更新时间</TableHead>
                  <TableHead>草稿状态 / 诊断状态</TableHead>
                  <TableHead>店铺 / 文件</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.length ? (
                  drafts.map((draft) => (
                    <TableRow key={draft.id}>
                      <TableCell>
                        <p className="font-semibold text-ink">{draft.customerCode}</p>
                        <p className="mt-1 text-xs text-muted">{dateTime(draft.updatedAt)}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{draft.statusLabel}</Badge>
                        <p className="mt-1 text-xs text-muted">{draft.validationStatusLabel}</p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-ink">{`${draft.groupCount} 个店铺`}</p>
                        <p className="mt-1 text-xs text-muted">{`${draft.fileCount} 个文件`}</p>
                      </TableCell>
                      <TableCell className="text-sm text-muted">{dateTime(draft.expiresAt)}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/bulk-orders/${draft.id}`}>查看诊断</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell className="h-28 text-center text-muted" colSpan={5}>
                      没有符合条件的批量草稿。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ResponsiveDataTable>
        </div>
        <div className="divide-y divide-border md:hidden">
          {drafts.length ? (
            drafts.map((draft) => (
              <article className="space-y-3 p-4" key={draft.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-ink">{draft.customerCode}</p>
                    <p className="mt-1 text-xs text-muted">{dateTime(draft.updatedAt)}</p>
                  </div>
                  <Badge variant="secondary">{draft.statusLabel}</Badge>
                </div>
                <p className="text-sm text-muted">{`${draft.groupCount} 个店铺 · ${draft.fileCount} 个文件`}</p>
                <p className="text-xs text-muted">{draft.validationStatusLabel}</p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/bulk-orders/${draft.id}`}>查看诊断</Link>
                </Button>
              </article>
            ))
          ) : (
            <div className="p-10 text-center text-sm text-muted">没有符合条件的批量草稿。</div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
