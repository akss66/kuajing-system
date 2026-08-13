import Link from "next/link";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAuditLogs } from "@/modules/audit/query";
import {
  auditActionOptions,
  auditEntityOptions,
  formatAuditAction,
  formatAuditActorType,
  formatAuditEntity,
} from "@/modules/audit/ui-labels";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const filters = await searchParams;
  const rows = await listAuditLogs({
    action: filters.action?.trim() || undefined,
    actorType: ["ADMIN", "CUSTOMER", "SYSTEM"].includes(filters.actorType ?? "")
      ? (filters.actorType as "ADMIN" | "CUSTOMER" | "SYSTEM")
      : undefined,
    entityType: filters.entityType?.trim() || undefined,
  });

  const hasFilters = Boolean(filters.action || filters.actorType || filters.entityType);
  const selectedAction = auditActionOptions.some((option) => option.value === filters.action)
    ? filters.action
    : "";
  const selectedEntity = auditEntityOptions.some((option) => option.value === filters.entityType)
    ? filters.entityType
    : "";

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/system/health", label: "系统健康" },
          { label: "审计日志" },
        ]}
        description="只读查看客户、商品、价格、库存与系统动作的关键变更记录。"
        title="审计日志"
      />

      <section aria-label="常用审计筛选" className="border-y border-border py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <form className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end" method="get">
            {filters.action ? <input name="action" type="hidden" value={filters.action} /> : null}
            {filters.entityType ? <input name="entityType" type="hidden" value={filters.entityType} /> : null}
            <label className="flex-1 space-y-2 text-sm font-medium text-ink">
            操作主体
            <select
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3"
              defaultValue={filters.actorType ?? ""}
              name="actorType"
            >
              <option value="">全部</option>
              <option value="ADMIN">管理员</option>
              <option value="CUSTOMER">客户</option>
              <option value="SYSTEM">系统</option>
            </select>
            </label>
            <Button className="sm:w-fit" type="submit">应用筛选</Button>
          </form>
          <EntityDrawer
            description="操作事件和业务对象属于低频精确条件。"
            title="更多审计筛选"
            trigger={<Button variant="outline">更多筛选</Button>}
          >
            <form className="grid gap-4" method="get">
              {filters.actorType ? <input name="actorType" type="hidden" value={filters.actorType} /> : null}
              <label className="space-y-2 text-sm font-medium text-ink">
                操作事件
                <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3" defaultValue={selectedAction} name="action">
                  <option value="">全部事件</option>
                  {auditActionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium text-ink">
                业务对象
                <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3" defaultValue={selectedEntity} name="entityType">
                  <option value="">全部对象</option>
                  {auditEntityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <Button type="submit">应用更多筛选</Button>
            </form>
          </EntityDrawer>
          {hasFilters ? <Button asChild variant="ghost"><Link href="/admin/system/audit">清除筛选</Link></Button> : null}
        </div>
      </section>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="时间按多伦多时区展示。这里只展示脱敏后的审计字段，不包含业务敏感明文。"
          title="审计记录"
        />
        <ResponsiveDataTable>
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>操作主体</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>原因</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">
                    {row.createdAt.toLocaleString("zh-CN", {
                      timeZone: "America/Toronto",
                    })}
                  </TableCell>
                  <TableCell>{formatAuditActorType(row.actorType)}</TableCell>
                  <TableCell className="font-medium">{formatAuditAction(row.action)}</TableCell>
                  <TableCell>
                    {formatAuditEntity(row.entityType)} · {row.entityId}
                  </TableCell>
                  <TableCell className="max-w-sm whitespace-normal">
                    {row.reason}
                  </TableCell>
                </TableRow>
              ))
            ) : (
                <TableRow><TableCell className="p-4" colSpan={5}><ActionableEmptyState action={<Button asChild size="sm" variant="outline"><Link href={hasFilters ? "/admin/system/audit" : "/admin/system/health"}>{hasFilters ? "清除筛选" : "查看系统健康"}</Link></Button>} description={hasFilters ? "当前主体、事件或业务对象组合没有命中记录。" : "关键资料、库存、资金和系统操作产生后会保留在这里。"} kind={hasFilters ? "filtered" : "initial"} title={hasFilters ? "没有符合条件的审计记录" : "暂无审计记录"} /></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>
    </div>
  );
}
