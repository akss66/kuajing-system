import { ArrowRight, Clock3, Plus, Store } from "lucide-react";
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

function isWritableDraftStatus(status: string) {
  return status === "DRAFT" || status === "PARTIALLY_SUBMITTED";
}

function effectiveDraftStatus(status: string, expiresAt: Date, now: Date) {
  return isWritableDraftStatus(status) && expiresAt <= now ? "EXPIRED" : status;
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

  const now = new Date();
  const displayedDrafts = drafts.map((draft) => ({
    draft,
    status: effectiveDraftStatus(draft.status, draft.expiresAt, now),
  }));
  const writableDrafts = displayedDrafts.filter(({ status }) => isWritableDraftStatus(status));
  const latestDraft = writableDrafts[0]?.draft;

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <Link
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-primary-hover transition-colors hover:bg-surface"
            href="/portal/settlements"
          >
            查看合并付款记录
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
        description="按店铺上传多个 TEMU 原始 Excel，系统会跨文件去重；提交后可把所选拿货单合并为一次付款。"
        title="多店铺批量上传"
      />

      <section
        aria-label="多店铺上传下一步"
        className="grid gap-3 border-y border-border bg-background px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        {latestDraft ? (
          <div className="flex min-w-0 items-start gap-3">
            <Clock3 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="font-semibold text-ink">继续最近一次多店铺上传</p>
              <p className="mt-1 text-sm text-muted">
                {latestDraft.groupCount} 个店铺 · {latestDraft.fileCount} 个文件 · 更新于 {dateTime(latestDraft.updatedAt)}
              </p>
              <Link
                className="mt-3 inline-flex min-h-11 items-center gap-2 font-medium text-primary-hover"
                href={`/portal/bulk-orders/${latestDraft.id}`}
              >
                继续上次草稿
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </div>
        ) : (
          <div>
            <p className="font-semibold text-ink">开始一次新的多店铺上传</p>
            <p className="mt-1 text-sm text-muted">暂无可继续的草稿，新建后即可按店铺上传文件。</p>
          </div>
        )}
        <form action={createDraft}>
          <Button className="min-h-11 w-full px-4 sm:w-auto" disabled={!stores.length} type="submit" variant={latestDraft ? "outline" : "default"}>
            <Plus aria-hidden="true" />
            新建批量草稿
          </Button>
        </form>
      </section>

      <MetricStrip
        items={[
          { hint: "当前客户可提交的店铺", label: "可用店铺", value: String(stores.length) },
          { hint: "最近创建或更新的批量草稿", label: "最近草稿", value: String(drafts.length) },
          { hint: "仍可继续编辑或提交", label: "可继续提交", tone: writableDrafts.length ? "warning" : "default", value: String(writableDrafts.length) },
          { hint: "所选拿货单只需支付一次", label: "付款方式", value: "一次合并" },
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
            {displayedDrafts.map(({ draft, status }) => (
              <article
                className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={draft.id}
              >
                <div className="space-y-1">
                  <p className="font-medium text-ink">{draftStatusLabel(status)}</p>
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
                  {isWritableDraftStatus(status) ? "继续草稿" : "查看草稿"}
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
