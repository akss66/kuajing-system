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
  FULFILLING: "待仓库发货",
  FULFILLMENT_EXCEPTION: "仓库处理异常",
  PAID_PENDING_FULFILLMENT: "已付款 / 待发货",
  PENDING_PAYMENT: "待付款",
  SHIPPED: "仓库已发货",
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

  return (
    <div className="space-y-5">
      <PageHeading
        breadcrumbs={[
          { href: "/portal/orders", label: "我的订单" },
          { label: order.orderNumber },
        ]}
        description={`${order.storeName} · 创建于 ${dateTime(order.createdAt)}（渥太华）`}
        title={order.orderNumber}
      />

      <div className="flex items-center gap-3">
        <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover" href="/portal/orders">
          <ArrowLeft className="size-4" />
          返回我的订单
        </Link>
        <Badge className={paid ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">
          {labels[order.status]}
        </Badge>
      </div>

      <MetricStrip
        items={[
          { label: "实际金额", value: money(order.totalAmountFen) },
          { label: "包裹数", value: String(order.totalPackageCount) },
          { label: "商品件数", value: String(order.totalQuantity) },
          { hint: "履约与付款状态见下方", label: "订单状态", tone: paid ? "success" : "warning", value: labels[order.status] },
        ]}
      />

      <OrderStatusTimeline
        orderStatus={order.status}
        paidAt={order.paidAt}
        paymentClaimStatus={order.latestPaymentClaim?.status ?? null}
        refundedAt={order.refundedAt}
        replacementStatuses={order.shipments.map((shipment) => shipment.replacementStatus)}
        shipmentStatuses={order.shipments.map((shipment) => shipment.fulfillmentStatus)}
      />

      <OrderStatusPanel order={order} />

      <CustomerOrderActions order={order} />

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
