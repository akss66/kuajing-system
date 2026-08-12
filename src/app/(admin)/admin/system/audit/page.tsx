import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAuditLogs } from "@/modules/audit/query";

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

  const actorSummary = rows.reduce(
    (summary, row) => {
      summary[row.actorType] = (summary[row.actorType] ?? 0) + 1;
      return summary;
    },
    {} as Record<string, number>,
  );

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

      <MetricStrip
        items={[
          { label: "命中记录", value: `${rows.length}` },
          { label: "管理员动作", value: `${actorSummary.ADMIN ?? 0}` },
          { label: "客户动作", value: `${actorSummary.CUSTOMER ?? 0}` },
          { label: "系统动作", value: `${actorSummary.SYSTEM ?? 0}` },
        ]}
      />

      <WorkspacePanel className="p-4 sm:p-5">
        <form className="grid gap-3 sm:grid-cols-3" method="get">
          <label className="space-y-2 text-sm font-medium text-ink">
            操作类型
            <input
              className="min-h-11 w-full rounded-lg border border-border px-3"
              defaultValue={filters.action ?? ""}
              name="action"
              placeholder="例如 INVENTORY_ADJUSTED"
            />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            主体类型
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
          <label className="space-y-2 text-sm font-medium text-ink">
            对象类型
            <input
              className="min-h-11 w-full rounded-lg border border-border px-3"
              defaultValue={filters.entityType ?? ""}
              name="entityType"
              placeholder="例如 SKU_INVENTORY"
            />
          </label>
          <button
            className="min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-white sm:col-span-3 sm:w-fit"
            type="submit"
          >
            筛选日志
          </button>
        </form>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="时间按多伦多时区展示。这里只展示脱敏后的审计字段，不包含业务敏感明文。"
          title="审计记录"
        />
        <Table>
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
                  <TableCell>{row.actorType}</TableCell>
                  <TableCell className="font-medium">{row.action}</TableCell>
                  <TableCell>
                    {row.entityType} · {row.entityId}
                  </TableCell>
                  <TableCell className="max-w-sm whitespace-normal">
                    {row.reason}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-28 text-center text-muted" colSpan={5}>
                  暂无符合条件的审计记录。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </WorkspacePanel>
    </div>
  );
}
