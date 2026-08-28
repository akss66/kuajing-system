import { AlertTriangle, ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { ImportReviewTable } from "@/components/order-import/import-review-table";
import { OrderSubmitButton } from "@/components/orders/order-submit-button";
import { calculateLineAmountFen } from "@/modules/catalog/unit-price";
import {
  generateAiSkuMatchSuggestionsAction,
  rejectAiSkuMatchSuggestionAction,
} from "@/modules/ai-sku-matching/actions";
import {
  getAiSkuMatchAvailability,
  listActiveAiSkuMatchSuggestions,
} from "@/modules/ai-sku-matching/service";
import { requireCustomer } from "@/modules/identity/guards";
import { updateCustomerImportRowAction } from "@/modules/order-import/actions";
import { submitImportBatchAction } from "@/modules/orders/actions";
import { PACKAGE_SHIPPING_FEE_FEN } from "@/modules/orders/pricing";
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

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
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

  const aiAvailability = await getAiSkuMatchAvailability(principal.customerId);
  const aiSuggestions = aiAvailability.enabled
    ? await listActiveAiSkuMatchSuggestions(principal.customerId, batchId)
    : [];
  const aiSuggestionByRow = new Map(
    aiSuggestions.map((suggestion) => [suggestion.rowId, suggestion]),
  );

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
  const merchandiseAmountFen = readyRows.reduce((total, row) => {
    if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") return total;
    const unitPriceMilliYuan = row.resolvedSku?.unitPriceMilliYuan;
    const rowQuantity = row.effectiveQuantity ?? row.quantity;
    if (unitPriceMilliYuan == null || rowQuantity == null) return total;
    return total + calculateLineAmountFen(rowQuantity, unitPriceMilliYuan);
  }, 0);
  const shippingFeeFen = packageCount * PACKAGE_SHIPPING_FEE_FEN;
  const estimatedTotalFen = merchandiseAmountFen + shippingFeeFen;

  return (
    <div className="space-y-5 pb-3">
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
          { href: "/portal", label: "经营概览" },
          { href: "/portal/imports/new", label: "导入订单" },
          { label: "核对 TEMU 订单" },
        ]}
        description={`${preview.storeName} · ${preview.fileName} · 共 ${preview.summary.total} 行`}
        title="核对 TEMU 订单"
      />

      {blocking ? (
        <div className="flex gap-3 rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 p-4 text-sm text-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">还有 {blocking} 行需要处理，暂不能提交拿货单</p>
            <p className="mt-1">
              请选择同系列替代 SKU、手动输入或调整数量；格式错误请修正 TEMU 文件后重新上传。重复订单会自动跳过。
            </p>
          </div>
        </div>
      ) : null}

      <MetricStrip
        compact
        items={[
          { label: "总行数", value: String(preview.summary.total) },
          { label: "待处理", value: String(blocking) },
          { label: "商品金额", value: money(merchandiseAmountFen) },
          {
            hint: `${packageCount} 包 × ${money(PACKAGE_SHIPPING_FEE_FEN)}`,
            label: "物流费",
            value: money(shippingFeeFen),
          },
          {
            hint: "提交时会按当前价格、库存和重复订单再次校验",
            label: "预计总额",
            value: money(estimatedTotalFen),
          },
        ]}
        variant="segmented"
      />

      <ImportReviewTable
        action={updateCustomerImportRowAction}
        aiSkuMatching={
          aiAvailability.enabled
            ? {
                generateAction: generateAiSkuMatchSuggestionsAction,
                rejectAction: rejectAiSkuMatchSuggestionAction,
              }
            : undefined
        }
        batchId={preview.batchId}
        rows={preview.rows.map((row) => ({
          ...row,
          aiSuggestion: aiSuggestionByRow.get(row.id) ?? null,
        }))}
      />

      <section
        aria-label="提交拿货单操作栏"
        className="sticky bottom-[calc(var(--merchant-mobile-dock-height)+env(safe-area-inset-bottom)+0.75rem)] z-20 rounded-2xl bg-white p-3 shadow-[0_-8px_24px_oklch(0.22_0.018_175/0.08)] sm:flex sm:items-end sm:justify-between sm:gap-3 sm:px-5 sm:py-4 lg:bottom-4"
      >
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            {blocking ? (
              <AlertTriangle aria-hidden="true" className="mt-0.5 hidden size-5 shrink-0 text-warning sm:block" />
            ) : (
              <ShieldCheck aria-hidden="true" className="mt-0.5 hidden size-5 shrink-0 text-success sm:block" />
            )}
            <div className="min-w-0">
              <p className="font-semibold text-ink">
                {blocking
                  ? `还有 ${blocking} 行待处理，暂不能提交`
                  : `已校验 ${preview.summary.ready} 行，可安全提交`}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {packageCount} 个包裹 · {quantity} 件商品
                {preview.summary.duplicate
                  ? ` · ${preview.summary.duplicate} 个重复订单自动跳过`
                  : ""}
                。预计总额 {money(estimatedTotalFen)}，提交时会再次校验价格、库存和重复订单。
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:mt-0 sm:flex sm:w-auto sm:items-end">
          <Link
            aria-label="返回重新上传"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm font-medium text-ink hover:bg-[var(--merchant-nav-hover)] sm:px-4"
            href="/portal/imports/new"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            <span className="hidden sm:inline">返回重新上传</span>
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
