import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { PaymentClaimReview } from "@/components/orders/payment-claim-review";
import { AdminFinanceNavigation } from "@/components/settlement/admin-finance-navigation";
import { SettlementRegion, SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/modules/identity/guards";
import { listPendingPaymentClaims } from "@/modules/orders/queries";
import { listAdminSettlementBatches, listPendingOfflineRefunds } from "@/modules/settlement/admin-queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

function refundAge(value: Date, now = new Date()) {
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86_400_000));
  return elapsedDays === 0 ? "等待不足 1 天" : `已等待 ${elapsedDays} 天`;
}

export default async function SettlementPage() {
  await requireAdmin();
  const [pendingClaims, pendingBatches, pendingRefunds] = await Promise.all([
    listPendingPaymentClaims(),
    listAdminSettlementBatches({ status: "PAYMENT_REPORTED" }),
    listPendingOfflineRefunds(),
  ]);
  const pendingClaimFen = pendingClaims.reduce((sum, claim) => sum + claim.amountFen, 0);
  const pendingRefundFen = pendingRefunds.reduce((sum, refund) => sum + refund.offlineAmountFen, 0);

  return (
    <div className="space-y-5">
      <PageHeading
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "收款审核" }]}
        description="集中处理单张拿货单收款和取消后的线下退款；客户余额与合并付款分别在独立工作区处理。"
        title="收款审核"
      />
      <AdminFinanceNavigation active="payments" />
      <MetricStrip
        compact
        items={[
          { hint: `待核金额 ${money(pendingClaimFen)}`, label: "单张待核款", tone: pendingClaims.length ? "warning" : "default", value: String(pendingClaims.length) },
          { hint: `待退金额 ${money(pendingRefundFen)}`, label: "待线下退款", tone: pendingRefunds.length ? "danger" : "default", value: String(pendingRefunds.length) },
          { hint: "在合并付款审核工作区处理", label: "合并付款待审核", tone: pendingBatches.length ? "warning" : "default", value: String(pendingBatches.length) },
        ]}
      />

      <SettlementWorkspace>
        <SettlementRegion
          description="客户为单张拿货单申报微信付款后出现在这里；确认到账后订单直接进入待发货。"
          kind="review"
          title="单张拿货单待核款"
        >
          {pendingClaims.length ? (
            <div className="divide-y divide-border">
              {pendingClaims.map((claim) => (
                <article className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[1fr_1.45fr] xl:items-center" key={claim.claimId}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-ink">{claim.orderNumber}</p>
                      <Badge className="bg-warning/10 text-warning" variant="secondary">待核款</Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted">{`${claim.customerCode} · ${claim.customerName} · ${claim.storeName}`}</p>
                    <p className="mt-2 text-xl font-semibold tabular-nums text-ink">{money(claim.amountFen)}</p>
                    <p className="mt-1 text-xs text-muted">申报于 {dateTime(claim.createdAt)}（渥太华）</p>
                    {claim.note ? <p className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">备注：{claim.note}</p> : null}
                  </div>
                  <PaymentClaimReview amountFen={claim.amountFen} claimId={claim.claimId} orderNumber={claim.orderNumber} />
                </article>
              ))}
            </div>
          ) : <div className="px-5 py-10 text-center text-sm text-muted" role="status">暂无需要核对的单张微信付款。</div>}
        </SettlementRegion>

        <SettlementRegion
          description="已取消且使用微信线下付款的包裹需要人工退款；进入订单详情登记完成结果。"
          id="pending-offline-refunds"
          kind="refunds"
        >
          {pendingRefunds.length ? (
            <ResponsiveDataTable>
              <Table>
                <TableHeader><TableRow><TableHead>客户</TableHead><TableHead>拿货单 / 平台单号</TableHead><TableHead>创建时间 / 账龄</TableHead><TableHead className="text-right">待退款</TableHead><TableHead className="text-right">处理</TableHead></TableRow></TableHeader>
                <TableBody>{pendingRefunds.map((refund) => (
                  <TableRow key={refund.shipmentId}>
                    <TableCell><p className="font-medium">{refund.customerCode}</p><p className="text-xs text-muted">{refund.customerName}</p></TableCell>
                    <TableCell><p className="font-medium">{refund.orderNumber}</p><p className="text-xs text-muted">{refund.externalOrderNo}</p></TableCell>
                    <TableCell><p>{dateTime(refund.createdAt)}</p><p className="text-xs text-warning">{refundAge(refund.createdAt)}</p></TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-danger">{money(refund.offlineAmountFen)}</TableCell>
                    <TableCell className="text-right"><Link className="font-medium text-primary hover:underline" href={`/admin/orders/${refund.orderId}`}>进入订单详情处理</Link></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </ResponsiveDataTable>
          ) : <div className="px-5 py-10 text-center text-sm text-muted" role="status">暂无线下退款待办。</div>}
        </SettlementRegion>

        <SettlementRegion
          description="客户一次支付多张拿货单时形成一笔合并付款，需要整笔确认或拒绝。"
          kind="batches"
          title="合并付款审核"
        >
          <Link className="flex min-h-20 items-center justify-between gap-4 p-4 transition-colors hover:bg-surface sm:p-5" href="/admin/settlement-batches">
            <span><strong className="text-ink">进入合并付款审核</strong><span className="mt-1 block text-sm text-muted">查看订单组成、余额抵扣、微信待付和审核结果。</span></span>
            <span className="flex shrink-0 items-center gap-2"><Badge variant="secondary">待审核 {pendingBatches.length}</Badge><ChevronRight aria-hidden="true" className="size-4 text-primary" /></span>
          </Link>
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
