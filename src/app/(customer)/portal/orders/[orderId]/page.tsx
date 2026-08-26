import { ArrowLeft, PackageCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { CustomerOrderActions } from "@/components/orders/customer-order-actions";
import { OrderStatusPanel } from "@/components/orders/order-status-panel";
import { OrderStatusTimeline } from "@/components/orders/order-status-timeline";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { formatMilliYuan } from "@/modules/catalog/unit-price";
import { getCustomerOrderDetail } from "@/modules/orders/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const labels = {
  CANCELLED: "已取消",
  EXPIRED: "已超时",
  FULFILLING: "仓库处理中",
  FULFILLMENT_EXCEPTION: "需要协助",
  PAID_PENDING_FULFILLMENT: "已付款 / 待发货",
  PENDING_PAYMENT: "待付款",
  SHIPPED: "已发货",
} as const;

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function CustomerOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const principal = await requireCustomer();
  const order = await getCustomerOrderDetail(principal.customerId, (await params).orderId);
  if (!order) notFound();

  const paid = ["PAID_PENDING_FULFILLMENT", "FULFILLING", "SHIPPED"].includes(order.status);
  const cancellationAdjustments = order.cancellationAdjustments ?? [];

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Badge className={paid ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">
              {labels[order.status]}
            </Badge>
            {order.cancellationState === "PARTIAL" ? <Badge className="bg-warning/10 text-warning" variant="secondary">部分取消</Badge> : null}
            <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover" href="/portal/orders">
              <ArrowLeft className="size-4" />
              返回我的订单
            </Link>
          </div>
        }
        breadcrumbs={[
          { href: "/portal/orders", label: "我的订单" },
          { label: order.orderNumber },
        ]}
        description={`${order.storeName} · 创建于 ${dateTime(order.createdAt)}（渥太华）`}
        title={order.orderNumber}
      />

      <MetricStrip
        items={[
          { hint: (order.adjustedAmountFen ?? 0) > 0 ? `原始金额 ${money(order.totalAmountFen)}` : undefined, label: "当前净额", value: money(order.netAmountFen ?? order.totalAmountFen) },
          { label: "包裹数", value: String(order.totalPackageCount) },
          { label: "商品件数", value: String(order.totalQuantity) },
          ...((order.adjustedAmountFen ?? 0) > 0
            ? [{ hint: "被取消包裹的商品额与每包 13 元物流费", label: "取消调整", value: `-${money(order.adjustedAmountFen ?? 0)}` }]
            : []),
        ]}
      />

      <OrderStatusTimeline
        audience="customer"
        orderStatus={order.status}
        paidAt={order.paidAt}
        paymentClaimStatus={order.latestPaymentClaim?.status ?? null}
        refundedAt={order.refundedAt}
        replacementStatuses={order.shipments.map((shipment) => shipment.replacementStatus)}
        shipmentStatuses={order.shipments.map((shipment) => shipment.fulfillmentStatus)}
      />

      <OrderStatusPanel order={order} />

      <CustomerOrderActions order={order} />

      {cancellationAdjustments.length > 0 ? (
        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader
            description="拿货单保留导入批次原始金额；取消包裹按商品金额与每包 13 元物流费单独冲减或退款。"
            title="取消与退款"
          />
          <div className="divide-y divide-border">
            {cancellationAdjustments.map((adjustment, index) => (
              <article className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5" key={adjustment.shipmentId}>
                <div>
                  <p className="font-semibold text-ink">取消包裹 {index + 1} · {money(adjustment.totalAmountFen)}</p>
                  <p className="mt-1 text-xs text-muted">商品 {money(adjustment.merchandiseAmountFen)} + 物流费 {money(adjustment.shippingFeeFen)}</p>
                  {adjustment.status !== "NOT_PAID" ? <p className="mt-1 text-xs text-muted">钱包退回 {money(adjustment.walletAmountFen)} · 线下退款 {money(adjustment.offlineAmountFen)}</p> : null}
                </div>
                <Badge className="w-fit bg-warning/10 text-warning" variant="secondary">
                  {adjustment.status === "NOT_PAID"
                    ? "已冲减应付金额"
                    : adjustment.status === "PENDING_OFFLINE"
                      ? "线下退款处理中"
                      : "退款处理完成"}
                </Badge>
              </article>
            ))}
          </div>
        </WorkspacePanel>
      ) : null}

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="价格为提交时实际成交价，后续改价不影响本单。"
          title={
            <span className="inline-flex items-center gap-2">
              <PackageCheck className="size-5 text-primary" />
              商品明细
            </span>
          }
        />
        <div className="divide-y divide-border">
          {order.lines.map((line) => (
            <article className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_90px_110px] sm:items-center sm:px-5" key={line.id}>
              <div>
                <p className="font-semibold text-ink">{line.skuCode}</p>
                <p className="mt-1 text-xs text-muted">{line.skuName}</p>
              </div>
              <div>
                <p className="text-sm text-ink">店铺 SKU：{line.externalSku}</p>
                <p className="mt-1 break-all text-xs text-muted">子订单：{line.externalSubOrderNo}</p>
              </div>
              <p className="text-sm tabular-nums text-muted sm:text-right">
                {line.quantity} × {formatMilliYuan(line.unitPriceMilliYuan)}
              </p>
              <p className="font-semibold tabular-nums text-ink sm:text-right">{money(line.lineAmountFen)}</p>
            </article>
          ))}
        </div>
      </WorkspacePanel>
    </div>
  );
}
