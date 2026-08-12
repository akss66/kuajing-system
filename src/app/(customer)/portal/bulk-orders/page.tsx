import { ArrowRight, Plus, Store } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Button } from "@/components/ui/button";
import { createBulkDraftAction } from "@/modules/bulk-order/actions";
import { listBulkDrafts } from "@/modules/bulk-order/draft-service";
import { requireCustomer } from "@/modules/identity/guards";
import { listActiveCustomerStores } from "@/modules/order-import/service";

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(value);
}

function draftStatusLabel(status: string) {
  switch (status) {
    case "PARTIALLY_SUBMITTED":
      return "部分已提交";
    case "COMPLETED":
      return "已完成";
    case "EXPIRED":
      return "已过期";
    default:
      return "草稿中";
  }
}

export default async function CustomerBulkOrdersPage() {
  const principal = await requireCustomer();
  const [stores, drafts] = await Promise.all([
    listActiveCustomerStores(principal.customerId),
    listBulkDrafts(principal.customerId),
  ]);

  async function createDraft() {
    "use server";

    const draft = await createBulkDraftAction();
    redirect(`/portal/bulk-orders/${draft.id}`);
  }

  const resumableDrafts = drafts.filter((draft) => draft.status !== "COMPLETED").length;

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <form action={createDraft}>
            <Button className="min-h-11 px-4" disabled={!stores.length} type="submit">
              <Plus aria-hidden="true" />
              新建批量草稿
            </Button>
          </form>
        }
        description="按店铺分组上传多个 TEMU 原始 Excel，系统会跨文件去重并合并成每店一张拿货单后统一付款。"
        title="多店铺批量拿货"
      />

      <MetricStrip
        items={[
          { hint: "当前客户可提交的店铺", label: "可用店铺", value: String(stores.length) },
          { hint: "最近创建或更新的批量草稿", label: "最近草稿", value: String(drafts.length) },
          { hint: "仍可继续编辑或提交", label: "可继续提交", tone: resumableDrafts ? "warning" : "default", value: String(resumableDrafts) },
          { hint: "统一结算的高频入口", label: "多店流程", value: "已开启" },
        ]}
      />

      {!stores.length ? (
        <WorkspacePanel className="border-warning/20 bg-warning/5 px-4 py-5 text-sm text-warning">
          当前没有可用店铺，请先联系管理员为你的客户账号启用店铺。
        </WorkspacePanel>
      ) : null}

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="默认按最近更新时间排序；已提交成功的店铺会从编辑区移除，失败文件会继续保留。"
          title={
            <span className="inline-flex items-center gap-2">
              <Store className="size-4 text-primary" />
              草稿列表
            </span>
          }
        />

        {drafts.length ? (
          <div className="divide-y divide-border">
            {drafts.map((draft) => (
              <article
                className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={draft.id}
              >
                <div className="space-y-1">
                  <p className="font-medium text-ink">{draftStatusLabel(draft.status)}</p>
                  <p className="text-sm text-muted">
                    {draft.groupCount} 个店铺 · {draft.fileCount} 个文件 · 更新于 {dateTime(draft.updatedAt)}
                  </p>
                  <p className="text-xs text-muted">
                    创建于 {dateTime(draft.createdAt)}，过期于 {dateTime(draft.expiresAt)}
                  </p>
                </div>
                <Link
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover"
                  href={`/portal/bulk-orders/${draft.id}`}
                >
                  进入草稿
                  <ArrowRight className="size-4" />
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="font-medium text-ink">还没有批量草稿</p>
            <p className="mt-1 text-sm text-muted">新建后即可按店铺分组上传多个 TEMU 原始 Excel。</p>
          </div>
        )}
      </WorkspacePanel>
    </div>
  );
}
