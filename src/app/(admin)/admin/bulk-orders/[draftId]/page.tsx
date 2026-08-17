import { notFound } from "next/navigation";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { getAdminBulkDraftDetail } from "@/modules/bulk-order/admin-queries";

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

export default async function AdminBulkOrderDetailPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = await params;
  const detail = await getAdminBulkDraftDetail(draftId);
  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <PageHeading
        action={<Badge variant="secondary">{detail.statusLabel}</Badge>}
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/bulk-orders", label: "批量草稿诊断" },
          { label: "草稿详情" },
        ]}
        description={`${detail.customerLabel} · 更新于 ${dateTime(detail.updatedAt)} · 过期于 ${dateTime(detail.expiresAt)}`}
        title="批量草稿诊断"
      />

      <MetricStrip
        items={[
          { label: "店铺分组", value: `${detail.storeGroups.length}` },
          {
            label: "含错误分组",
            value: `${detail.storeGroups.filter((group) => group.errorCodeLabels.length).length}`,
          },
          {
            label: "可提交分组",
            value: `${detail.storeGroups.filter((group) => group.statusLabel.includes("可")).length}`,
          },
        ]}
      />

      <section className="space-y-4">
        {detail.storeGroups.map((group) => (
          <WorkspacePanel className="overflow-hidden" key={group.groupId}>
            <WorkspacePanelHeader
              description={`店铺状态：${group.statusLabel}`}
              title={
                <span className="inline-flex items-center gap-2">
                  <span>{group.storeName}</span>
                  <Badge variant="secondary">{group.statusLabel}</Badge>
                </span>
              }
            />
            <div className="grid gap-4 p-4 sm:px-5 sm:py-5 xl:grid-cols-[1.1fr_0.9fr_0.9fr]">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-ink">文件摘要</h3>
                {group.fileSummaries.length ? (
                  group.fileSummaries.map((file) => (
                    <div
                      className="rounded-lg bg-surface px-3 py-3"
                      key={`${group.groupId}-${file.fileName}`}
                    >
                      <p className="font-medium text-ink">{file.fileName}</p>
                      <p className="mt-1 text-sm text-muted">
                        {`${bytes(file.fileSizeBytes)} · 原始 ${file.totalRows} 行 · 可用 ${file.readyRows} 行`}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {`重复 ${file.duplicateRows} · 未映射 SKU ${file.unknownSkuRows} · 格式问题 ${file.invalidRows}`}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-surface px-3 py-3 text-sm text-muted">
                    暂无文件摘要。
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-ink">冲突与错误码</h3>
                {group.errorCodeLabels.length ? (
                  group.errorCodeLabels.map((label) => (
                    <div
                      className="rounded-lg bg-surface px-3 py-3 text-sm text-ink"
                      key={`${group.groupId}-${label}`}
                    >
                      {label}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg bg-surface px-3 py-3 text-sm text-muted">
                    当前没有诊断错误码。
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-ink">部分提交结果</h3>
                <div className="rounded-lg bg-surface px-3 py-3 text-sm text-muted">
                  <p>{`可用行 ${group.partialResultSummary.readyRows}`}</p>
                  <p className="mt-1">{`重复行 ${group.partialResultSummary.duplicateRows}`}</p>
                  <p className="mt-1">{`未映射 SKU ${group.partialResultSummary.unknownSkuRows}`}</p>
                  <p className="mt-1">{`格式问题 ${group.partialResultSummary.invalidRows}`}</p>
                </div>
              </section>
            </div>
          </WorkspacePanel>
        ))}
      </section>
    </div>
  );
}
