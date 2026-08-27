import { ArrowRight, Clock3, Store } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CreateBulkDraftSubmit } from "@/components/bulk-order/create-bulk-draft-submit";
import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { DiscardBulkDraftForm } from "@/components/bulk-order/discard-bulk-draft-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Button } from "@/components/ui/button";
import { createBulkDraftAction } from "@/modules/bulk-order/actions";
import { listBulkDrafts } from "@/modules/bulk-order/draft-service";
import { requireCustomer } from "@/modules/identity/guards";
import { listActiveCustomerStores } from "@/modules/order-import/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
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
      return "上传中";
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
  const latestWritable = writableDrafts[0];
  const latestDraft = latestWritable?.draft;
  const otherDrafts = displayedDrafts.filter(
    ({ draft }) => draft.id !== latestDraft?.id,
  );
  const activeFileCount = writableDrafts.reduce(
    (total, { draft }) => total + draft.fileCount,
    0,
  );
  const activeDraftCount = writableDrafts.length;
  const submittableGroupCount = writableDrafts.reduce(
    (total, { draft }) => total + draft.submittableGroupCount,
    0,
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeading
        action={
          <Button asChild className="min-h-11 w-full sm:w-auto" variant="outline">
            <Link href="/portal/settlements">
              查看合并付款记录
              <ArrowRight aria-hidden="true" className="size-4 group-hover/button:translate-x-0.5" />
            </Link>
          </Button>
        }
        description="按店铺上传多个 TEMU 原始 Excel，系统会跨文件去重；提交后可把所选拿货单合并为一次付款。"
        title="多店铺批量上传"
      />

      <WorkspacePanel className="overflow-hidden border-[var(--portal-border-strong)] bg-background">
        <ol className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          {[
            { step: "01", title: "按店铺上传", body: "每个店铺放自己的 TEMU 原始 Excel，系统自动去重并保留未提交内容。" },
            { step: "02", title: "逐店校验", body: "未映射 SKU、库存变化和格式问题会按店铺拆开提示，不会互相污染。" },
            { step: "03", title: "一次付款", body: "确认提交后，所选拿货单会汇总成一次付款记录，再进入履约流程。" },
          ].map((item) => (
            <li className="px-4 py-4 sm:px-5" key={item.step}>
              <div className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary-soft text-xs font-semibold tabular-nums text-primary-hover">
                  {item.step}
                </span>
                <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ol>
      </WorkspacePanel>

      <section
        aria-label="多店铺上传下一步"
        className="grid gap-4 rounded-[var(--portal-surface-radius)] border border-[var(--portal-border-strong)] bg-background px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
        data-portal-bulk-start
      >
        {latestDraft ? (
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-[0.8rem] bg-[var(--portal-icon-surface)] text-primary">
              <Clock3 aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-[-0.01em] text-primary-hover">继续最近一次多店铺上传</p>
              <p className="mt-1 text-sm text-muted">
                {latestDraft.groupCount} 个店铺 · {latestDraft.fileCount} 个文件 · 更新于 {dateTime(latestDraft.updatedAt)}（渥太华）
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Link
                  className="portal-inline-action inline-flex min-h-11 items-center gap-2 font-semibold text-primary-hover"
                  href={`/portal/bulk-orders/${latestDraft.id}`}
                >
                  继续上次上传
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
                {latestWritable.status === "DRAFT" ? (
                  <DiscardBulkDraftForm
                    compact
                    draftId={latestDraft.id}
                    empty={latestDraft.groupCount === 0 && latestDraft.fileCount === 0}
                  />
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-[-0.01em] text-primary-hover">开始一次新的多店铺上传</p>
            <p className="mt-1 text-sm leading-6 text-muted">暂无可继续的上传记录，开始后即可按店铺添加文件。</p>
          </div>
        )}
        {!latestDraft ? (
          <form action={createDraft} className="w-full sm:w-auto">
            <CreateBulkDraftSubmit disabled={!stores.length} />
          </form>
        ) : null}
      </section>

      <section aria-label="上传概况" className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">当前上传概况</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            先看可用店铺、进行中上传和当前可提交店铺，再决定继续处理还是开始新的批量上传。
          </p>
        </div>
        <MetricStrip
          compact
          items={[
            { label: "可用店铺", value: String(stores.length) },
            { label: "进行中上传", value: String(activeDraftCount) },
            { label: "已上传文件", value: String(activeFileCount) },
            { label: "可提交店铺", value: String(submittableGroupCount) },
          ]}
          variant="segmented"
        />
      </section>

      {!stores.length ? (
        <WorkspacePanel className="border-warning/20 bg-warning/5 px-4 py-5 text-sm text-warning">
          当前没有可用店铺，请先联系管理员为你的客户账号启用店铺。
        </WorkspacePanel>
      ) : null}

      <WorkspacePanel aria-label="上传记录" className="overflow-hidden">
        <WorkspacePanelHeader
          description="默认按最近更新时间排序；已提交成功的店铺会从编辑区移除，失败文件会继续保留。"
          title={
            <span className="inline-flex items-center gap-2">
              <Store className="size-4 text-primary" />
              上传记录
            </span>
          }
        />

        {otherDrafts.length ? (
          <div className="grid gap-3 bg-slate-50/50 p-3">
            {otherDrafts.map(({ draft, status }) => (
              <article
                className="flex flex-col gap-4 rounded-xl bg-white p-4 shadow-[0_1px_5px_rgb(15_23_42/0.03)] sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={draft.id}
              >
                <div className="space-y-1">
                  <p className="font-medium text-ink">{draftStatusLabel(status)}</p>
                  <p className="text-sm text-muted">
                    {draft.groupCount} 个店铺 · {draft.fileCount} 个文件 · 更新于 {dateTime(draft.updatedAt)}（渥太华）
                  </p>
                  <p className="text-xs text-muted">
                    创建于 {dateTime(draft.createdAt)}，过期于 {dateTime(draft.expiresAt)}（渥太华）
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {status === "DRAFT" ? (
                    <DiscardBulkDraftForm
                      compact
                      draftId={draft.id}
                      empty={draft.groupCount === 0 && draft.fileCount === 0}
                    />
                  ) : null}
                  <Link
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-hover"
                    href={`/portal/bulk-orders/${draft.id}`}
                  >
                    {isWritableDraftStatus(status) ? "继续上传" : "查看记录"}
                    <ArrowRight className="size-4" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : latestDraft ? (
          <div className="p-4 sm:p-5">
            <ActionableEmptyState
              action={
                <Link
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-hover"
                  href={`/portal/bulk-orders/${latestDraft.id}`}
                >
                  继续当前上传
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              }
              description="当前只有上方这一次进行中的上传；提交或放弃后，新的上传记录会继续保留在这里。"
              kind="initial"
              title="还没有历史上传记录"
            />
          </div>
        ) : (
          <div className="p-4 sm:p-5">
            <ActionableEmptyState
              action={
                <Link
                  className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-hover"
                  href="/portal/settlements"
                >
                  先查看合并付款记录
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              }
              description="开始一次上传后，这里会保留历史记录、状态和进入详情的入口。"
              kind="initial"
              title="还没有上传记录"
            />
          </div>
        )}
      </WorkspacePanel>
    </div>
  );
}
