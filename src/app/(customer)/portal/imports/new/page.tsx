import { ArrowRight, CheckCircle2, FileSpreadsheet, Store } from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
import { TemuUploadForm } from "@/components/order-import/temu-upload-form";
import { uploadTemuOrdersAction } from "@/modules/order-import/actions";
import { requireCustomer } from "@/modules/identity/guards";
import { listActiveCustomerStores } from "@/modules/order-import/service";

export default async function NewTemuImportPage() {
  const principal = await requireCustomer();
  const stores = await listActiveCustomerStores(principal.customerId);

  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <PageHeading
        description="直接使用 TEMU 后台导出的 33 列订单文件，系统会识别 SKU、重复订单和格式问题。"
        title="上传订单"
      />

      <section aria-labelledby="upload-checklist-title" className="grid gap-3 rounded-[var(--portal-surface-radius)] border border-primary/10 bg-primary-soft/35 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground" id="upload-checklist-title">上传前确认</h2>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2"><CheckCircle2 aria-hidden="true" className="size-4 text-success" />TEMU 原始 .xlsx</span>
            <span className="inline-flex items-center gap-2"><CheckCircle2 aria-hidden="true" className="size-4 text-success" />不超过 10 MB</span>
            <span className="inline-flex items-center gap-2"><CheckCircle2 aria-hidden="true" className="size-4 text-success" />最多 20,000 行</span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">当前可选 {stores.length} 家店铺</p>
      </section>

      <WorkspacePanel className="p-4 sm:p-6">
        <div className="mb-5 flex items-start gap-3 border-b border-border pb-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-hover">
            <FileSpreadsheet aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-ink">选择原始订单文件</h2>
            <p className="mt-1 text-sm text-muted">仅支持 .xlsx，单个文件不超过 10 MB、20,000 行。</p>
          </div>
        </div>

        {stores.length ? (
          <TemuUploadForm action={uploadTemuOrdersAction} stores={stores} />
        ) : (
          <div className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">
            当前没有可用店铺，请联系管理员为你的客户账户启用店铺。
          </div>
        )}
      </WorkspacePanel>

      <section className="flex flex-col gap-3 rounded-[var(--radius-surface)] border border-border bg-surface/55 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5" aria-label="多店铺上传">
        <div className="flex min-w-0 items-start gap-3">
          <Store aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">多个店铺都有订单？</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">高级流程支持一次上传多个店铺文件，并统一检查冲突。</p>
          </div>
        </div>
        <Link className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface" href="/portal/bulk-orders">
          多店铺批量上传 <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </section>
    </div>
  );
}
