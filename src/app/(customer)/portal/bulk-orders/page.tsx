import { ArrowRight, Plus, Store } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

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

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">客户操作面</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            多店铺批量拿货
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            按店铺分组上传多个 TEMU 原始 Excel，系统会跨文件去重，并合并成每店一张拿货单后统一付款。
          </p>
        </div>
        <form action={createDraft}>
          <Button className="min-h-11 px-4" disabled={!stores.length} type="submit">
            <Plus aria-hidden="true" />
            新建批量草稿
          </Button>
        </form>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "可用店铺", value: String(stores.length) },
          { label: "最近草稿", value: String(drafts.length) },
          {
            label: "可继续提交",
            value: String(
              drafts.filter((draft) => draft.status !== "COMPLETED").length,
            ),
          },
        ].map((item) => (
          <article
            className="rounded-[var(--radius-surface)] border border-border bg-background p-4"
            key={item.label}
          >
            <p className="text-sm text-muted">{item.label}</p>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-ink">{item.value}</p>
          </article>
        ))}
      </section>

      {!stores.length ? (
        <section className="rounded-[var(--radius-surface)] border border-warning/20 bg-warning/5 px-4 py-5 text-sm text-warning">
          当前没有可用店铺，请先联系管理员为你的客户账户启用店铺。
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2">
            <Store className="size-4 text-primary" />
            <h2 className="font-semibold text-ink">草稿列表</h2>
          </div>
          <p className="mt-1 text-sm text-muted">
            默认按最近更新时间排序；已提交成功的店铺会从编辑区移除，失败文件会继续保留。
          </p>
        </div>

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
                    {draft.groupCount} 个店铺 · {draft.fileCount} 个文件 · 更新于{" "}
                    {dateTime(draft.updatedAt)}
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
            <p className="mt-1 text-sm text-muted">
              新建后即可按店铺分组上传多个 TEMU 原始 Excel。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
