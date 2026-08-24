import { AlertTriangle, ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeading } from "@/components/layout/page-heading";
import { ImportProgress } from "@/components/order-import/import-progress";
import { ImportReviewTable } from "@/components/order-import/import-review-table";
import { OrderSubmitButton } from "@/components/orders/order-submit-button";
import { requireCustomer } from "@/modules/identity/guards";
import { updateCustomerImportRowAction } from "@/modules/order-import/actions";
import { submitImportBatchAction } from "@/modules/orders/actions";
import {
  ImportPreviewError,
  getCustomerImportPreview,
} from "@/modules/order-import/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function deadline(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function ImportPreviewPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const principal = await requireCustomer();
  const { batchId } = await params;
  let preview;

  try {
    preview = await getCustomerImportPreview(principal.customerId, batchId);
  } catch (error) {
    if (error instanceof ImportPreviewError && error.code === "PREVIEW_NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const blocking = preview.summary.unknownSku + preview.summary.invalid;
  const readyRows = preview.rows.filter((row) => row.status === "READY");
  const packageCount = new Set(
    readyRows
      .map((row) => row.externalOrderNo)
      .filter((value): value is string => Boolean(value)),
  ).size;
  const quantity = readyRows.reduce(
    (total, row) => total + (row.effectiveQuantity ?? row.quantity ?? 0),
    0,
  );

  return (
    <div className="space-y-5 pb-28 sm:pb-2">
      <PageHeading
        action={
          <div className="text-sm text-muted sm:text-right">
            <p>预览有效期至</p>
            <p className="mt-1 font-medium tabular-nums text-ink">
              {deadline(preview.expiresAt)}（多伦多）
            </p>
          </div>
        }
        breadcrumbs={[
          { href: "/portal", label: "商家中心" },
          { href: "/portal/imports/new", label: "导入订单" },
          { label: "核对 TEMU 订单" },
        ]}
        description={`${preview.storeName} · ${preview.fileName} · 共 ${preview.summary.total} 行`}
        title="核对 TEMU 订单"
      />

      <ImportProgress currentStep={3} />

      {blocking ? (
        <div className="flex gap-3 rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 p-4 text-sm text-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">还有 {blocking} 行需要处理，暂不能提交拿货单</p>
            <p className="mt-1 text-warning">
              请选择同系列替代 SKU、手动输入或调整数量；格式错误请修正 TEMU 文件后重新上传。重复订单会自动跳过。
            </p>
          </div>
        </div>
      ) : null}

      <ImportReviewTable
        action={updateCustomerImportRowAction}
        batchId={preview.batchId}
        rows={preview.rows}
      />

      <section
        aria-label="提交拿货单操作栏"
        className="sticky bottom-0 z-20 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-t-[var(--radius-surface)] border border-border bg-background/95 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_oklch(0.22_0.018_175/0.08)] backdrop-blur sm:bottom-4 sm:flex sm:justify-between sm:rounded-[var(--radius-surface)] sm:px-5 sm:py-3"
      >
        <div className="hidden min-w-0 items-start gap-3 sm:flex">
          {blocking ? (
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
          ) : (
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
          )}
          <div className="min-w-0">
            <p className="font-semibold text-ink">
              {blocking
                ? `还有 ${blocking} 行待处理，暂不能提交`
                : `已校验 ${preview.summary.ready} 行，可安全提交`}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted">
              {packageCount} 个包裹 · {quantity} 件商品
              {preview.summary.duplicate ? ` · ${preview.summary.duplicate} 个重复订单自动跳过` : ""}
              ；提交时会再次校验库存和重复订单。
            </p>
          </div>
        </div>
        <div className="contents sm:flex sm:w-auto sm:items-end sm:gap-2">
          <Link
            aria-label="返回重新上传"
            className="inline-flex size-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-background text-sm font-medium text-ink hover:bg-[var(--merchant-nav-hover)] sm:h-11 sm:w-auto sm:px-4"
            href="/portal/imports/new"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            <span className="sr-only sm:not-sr-only">返回重新上传</span>
          </Link>
          <OrderSubmitButton
            action={submitImportBatchAction}
            batchId={preview.batchId}
            disabled={blocking > 0 || preview.summary.ready === 0}
          />
        </div>
      </section>
    </div>
  );
}
