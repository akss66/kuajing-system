import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, FileWarning, HelpCircle } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { OrderSubmitButton } from "@/components/orders/order-submit-button";
import { requireCustomer } from "@/modules/identity/guards";
import { submitImportBatchAction } from "@/modules/orders/actions";
import {
  ImportPreviewError,
  getCustomerImportPreview,
} from "@/modules/order-import/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const statusMeta = {
  READY: { label: "可提交", className: "bg-success/10 text-success" },
  DUPLICATE: { label: "重复跳过", className: "bg-surface-muted text-muted" },
  UNKNOWN_SKU: { label: "未知 SKU", className: "bg-warning/10 text-warning" },
  INVALID: { label: "格式错误", className: "bg-danger/10 text-danger" },
} as const;

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
  const cards = [
    { label: "可提交", value: preview.summary.ready, icon: CheckCircle2, className: "text-success" },
    { label: "重复订单", value: preview.summary.duplicate, icon: Copy, className: "text-muted" },
    { label: "未知 SKU", value: preview.summary.unknownSku, icon: HelpCircle, className: "text-warning" },
    { label: "格式错误", value: preview.summary.invalid, icon: FileWarning, className: "text-danger" },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover" href="/portal/imports/new">
            <ArrowLeft aria-hidden="true" className="size-4" />重新上传
          </Link>
          <p className="mt-2 text-sm font-medium text-primary">导入预览</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">核对 TEMU 订单</h1>
          <p className="mt-2 text-sm text-muted">
            {preview.storeName} · {preview.fileName} · 共 {preview.summary.total} 行
          </p>
        </div>
        <div className="text-sm text-muted sm:text-right">
          <p>预览有效期至</p>
          <p className="mt-1 font-medium tabular-nums text-ink">{deadline(preview.expiresAt)}（渥太华）</p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="解析结果统计">
        {cards.map((card) => (
          <article className="rounded-[var(--radius-surface)] border border-border bg-background p-4" key={card.label}>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">{card.label}</p>
              <card.icon aria-hidden="true" className={`size-4 ${card.className}`} />
            </div>
            <p className={`mt-3 text-2xl font-semibold tabular-nums ${card.className}`}>{card.value}</p>
          </article>
        ))}
      </section>

      {blocking ? (
        <div className="flex gap-3 rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 p-4 text-sm text-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">还有 {blocking} 行需要处理，暂不能提交拿货单</p>
            <p className="mt-1 text-warning">未知 SKU 请联系管理员建立映射；格式错误请修正 TEMU 文件后重新上传。重复订单会自动跳过。</p>
          </div>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 className="font-semibold text-ink">逐行结果</h2>
            <p className="mt-1 text-xs text-muted">收件信息已加密，预览中不展示。</p>
          </div>
          <Badge variant="secondary">{preview.rows.length} 行</Badge>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-3 font-semibold">Excel 行</th>
                <th className="px-5 py-3 font-semibold">订单号</th>
                <th className="px-5 py-3 font-semibold">子订单号</th>
                <th className="px-5 py-3 font-semibold">SKU 货号</th>
                <th className="px-5 py-3 text-right font-semibold">数量</th>
                <th className="px-5 py-3 font-semibold">结果</th>
                <th className="px-5 py-3 font-semibold">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td className="px-5 py-3 tabular-nums text-muted">{row.rowNumber}</td>
                  <td className="px-5 py-3 font-medium text-ink">{row.externalOrderNo ?? "—"}</td>
                  <td className="px-5 py-3 text-muted">{row.externalSubOrderNo ?? "—"}</td>
                  <td className="px-5 py-3 font-medium text-ink">{row.externalSku ?? "—"}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{row.quantity ?? "—"}</td>
                  <td className="px-5 py-3"><Badge className={statusMeta[row.status].className} variant="secondary">{statusMeta[row.status].label}</Badge></td>
                  <td className="max-w-64 px-5 py-3 text-muted">{row.errorMessage ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-border md:hidden">
          {preview.rows.map((row) => (
            <article className="space-y-3 p-4" key={row.rowNumber}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-muted">Excel 第 {row.rowNumber} 行</p>
                  <p className="mt-1 font-semibold text-ink">{row.externalSku ?? "无法读取 SKU"}</p>
                </div>
                <Badge className={statusMeta[row.status].className} variant="secondary">{statusMeta[row.status].label}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted">订单号</dt><dd className="mt-1 break-all text-ink">{row.externalOrderNo ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted">子订单号</dt><dd className="mt-1 break-all text-ink">{row.externalSubOrderNo ?? "—"}</dd></div>
              </dl>
              {row.errorMessage ? <p className="rounded-lg bg-surface px-3 py-2 text-sm text-muted">{row.errorMessage}</p> : null}
            </article>
          ))}
        </div>
      </section>

      <div className="flex flex-col gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {blocking ? "处理全部未知 SKU 和格式错误后再提交。" : `已核对 ${preview.summary.ready} 行可提交订单。`}
        </p>
        <OrderSubmitButton action={submitImportBatchAction} batchId={preview.batchId} disabled={blocking > 0 || preview.summary.ready === 0} />
      </div>
    </div>
  );
}
