import { ArrowLeft, Box, CircleAlert, PackageCheck, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/forms/action-form";
import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { OrderStatusTimeline } from "@/components/orders/order-status-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cancelJifengShipmentAction,
  createReplacementAction,
  retryJifengShipmentAction,
} from "@/modules/fulfillment/actions";
import { formatReplacementStatus } from "@/modules/fulfillment/replacement-ui-labels";
import { formatMilliYuan } from "@/modules/catalog/unit-price";
import { getAdminOrderDetail } from "@/modules/orders/queries";
import { getAdminSettlementOrderStatusLabel } from "@/modules/settlement/admin-ui-labels";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const statusLabels: Record<string, string> = {
  CANCELLED: "已取消",
  CANCEL_PENDING: "取消中",
  EXCEPTION: "异常",
  FULFILLING: "待仓库发货",
  PENDING: "待推送",
  SHIPPED: "仓库已发货",
  SUBMITTED: "已提交极风",
  SUBMITTING: "提交中",
};

function dateTime(value: Date | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: BUSINESS_TIME_ZONE,
      }).format(value)
    : "—";
}

function fee(value: number | null, currency: string | null) {
  return value === null ? "—" : `${currency ?? "CAD"} ${(value / 100).toFixed(2)}`;
}

function statusClass(status: string | null) {
  if (status === "EXCEPTION") return "bg-danger/10 text-danger";
  if (status === "SHIPPED") return "bg-success/10 text-success";
  if (status === "CANCELLED") return "bg-surface-muted text-muted";
  return "bg-primary-soft text-primary-hover";
}

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const order = await getAdminOrderDetail(orderId);
  if (!order) notFound();

  return (
    <div className="space-y-6">
      <PageHeading
        action={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button asChild className="min-h-11" variant="outline">
              <Link href="/admin/orders">
                <ArrowLeft aria-hidden="true" />
                返回订单列表
              </Link>
            </Button>
            <Badge className="w-fit bg-primary-soft px-3 py-1.5 text-primary-hover" variant="secondary">
              {getAdminSettlementOrderStatusLabel(order.status)}
            </Badge>
          </div>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/orders", label: "订单管理" },
          { label: order.orderNumber },
        ]}
        description={`${order.customerCode} · ${order.customerName} / ${order.storeName}`}
        title={order.orderNumber}
      />

      <MetricStrip
        items={[
          { label: "包裹数", value: `${order.shipments.length}` },
          { label: "商品件数", value: `${order.totalQuantity}` },
          { label: "实际成交额", value: `¥${(order.totalAmountFen / 100).toFixed(2)}` },
          { label: "创建时间", value: dateTime(order.createdAt) },
        ]}
      />

      <OrderStatusTimeline
        orderStatus={order.status}
        paidAt={order.paidAt}
        refundedAt={order.refundedAt}
        replacementStatuses={order.shipments.map((shipment) => shipment.replacementStatus)}
        shipmentStatuses={order.shipments.map((shipment) => shipment.fulfillmentStatus)}
      />

      <div className="space-y-5">
        {order.shipments.map((shipment, shipmentIndex) => {
          const canRetry = shipment.fulfillmentStatus === "EXCEPTION";
          const canCancel = shipment.fulfillmentStatus !== null && !["SHIPPED", "CANCELLED", "CANCEL_PENDING"].includes(shipment.fulfillmentStatus);
          const canReplace = shipment.kind === "NORMAL" && shipment.fulfillmentStatus === "SHIPPED";
          return (
            <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background" key={shipment.id}>
              <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="flex items-center gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><Box /></div><div><h2 className="font-semibold text-ink">{shipment.kind === "REPLACEMENT" ? "补发包裹" : `普通包裹 ${shipmentIndex + 1}`}</h2><p className="mt-0.5 text-xs text-muted">平台订单 {shipment.externalOrderNo}</p></div></div>
                <Badge className={statusClass(shipment.fulfillmentStatus)} variant="secondary">{statusLabels[shipment.fulfillmentStatus ?? ""] ?? "尚未进入极风"}</Badge>
              </div>

              <div className="grid gap-x-6 gap-y-4 border-b border-border p-4 text-sm sm:grid-cols-2 lg:grid-cols-4 sm:p-5">
                <div><p className="text-xs text-muted">极风 ERP 单号</p><p className="mt-1 break-all font-medium text-ink">{shipment.erpNo ?? "—"}</p></div>
                <div><p className="text-xs text-muted">极风状态码</p><p className="mt-1 font-medium text-ink">{shipment.jifengStatus ?? "—"}</p></div>
                <div><p className="text-xs text-muted">加拿大邮政运单</p><p className="mt-1 break-all font-medium text-ink">{shipment.trackingNumber ?? "—"}</p></div>
                <div><p className="text-xs text-muted">物流费用</p><p className="mt-1 font-medium text-ink">{fee(shipment.logisticsFeeMinor, shipment.logisticsCurrency)}</p></div>
                <div><p className="text-xs text-muted">发货时间</p><p className="mt-1 font-medium text-ink">{dateTime(shipment.shippedAt)}</p></div>
                <div><p className="text-xs text-muted">外部调用次数</p><p className="mt-1 font-medium text-ink">{shipment.attemptCount ?? 0} 次</p></div>
                <div><p className="text-xs text-muted">下次重试</p><p className="mt-1 font-medium text-ink">{dateTime(shipment.nextRetryAt)}</p></div>
                <div><p className="text-xs text-muted">补发状态 / 原因</p><p className="mt-1 font-medium text-ink">{shipment.replacementStatus === "FULFILLING" ? "补发待仓库发货" : shipment.replacementStatus === "SHIPPED" ? "补发仓库已发货" : shipment.replacementStatus ? formatReplacementStatus(shipment.replacementStatus) : "—"}{shipment.replacementReason ? ` · ${shipment.replacementReason}` : ""}</p></div>
              </div>

              {shipment.lastErrorCode ? <div className="flex gap-3 border-b border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger sm:px-5"><CircleAlert className="mt-0.5 size-4 shrink-0" /><div><p className="font-semibold">{shipment.lastErrorCode}</p><p className="mt-1">{shipment.lastErrorMessage}</p></div></div> : null}

              <div className="p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-ink">包裹商品</h3>
                <div className="mt-3 divide-y divide-border rounded-xl border border-border">
                  {shipment.lines.map((line) => <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-3 text-sm sm:grid-cols-[1fr_0.7fr_auto]" key={line.id}><div><p className="font-medium text-ink">{line.skuCode}</p><p className="mt-0.5 text-xs text-muted">{line.skuName}</p></div><p className="hidden self-center text-muted sm:block">{formatMilliYuan(line.unitPriceMilliYuan)} / 件</p><p className="self-center font-semibold tabular-nums">× {line.quantity}</p></div>)}
                </div>
              </div>

              {(canRetry || canCancel || canReplace) ? <div className="grid gap-4 border-t border-border bg-surface/60 p-4 lg:grid-cols-3 sm:p-5">
                {canRetry ? <ActionForm action={retryJifengShipmentAction} className="space-y-3 rounded-xl border border-border bg-background p-4" submitLabel="加入重试队列"><input name="orderId" type="hidden" value={order.id} /><input name="shipmentId" type="hidden" value={shipment.id} /><div><p className="flex items-center gap-2 text-sm font-semibold text-ink"><RefreshCcw className="size-4" />重试极风</p><p className="mt-1 text-xs text-muted">清除当前安全错误摘要并重新推送。</p></div><Input maxLength={1000} name="reason" placeholder="填写重试原因" required /><label className="flex items-start gap-2 text-xs text-muted"><input className="mt-0.5" required type="checkbox" />我已核对错误信息并确认重试</label></ActionForm> : null}
                {canCancel ? <ActionForm action={cancelJifengShipmentAction} className="space-y-3 rounded-xl border border-border bg-background p-4" submitLabel="向极风申请取消"><input name="orderId" type="hidden" value={order.id} /><input name="shipmentId" type="hidden" value={shipment.id} /><div><p className="text-sm font-semibold text-ink">取消未发货包裹</p><p className="mt-1 text-xs text-muted">只有极风确认后才会释放库存。</p></div><Input maxLength={1000} name="reason" placeholder="填写取消原因" required /><label className="flex items-start gap-2 text-xs text-muted"><input className="mt-0.5" required type="checkbox" />我确认取消会终止该包裹履约</label></ActionForm> : null}
                {canReplace ? <ActionForm action={createReplacementAction} className="space-y-3 rounded-xl border border-border bg-background p-4 lg:col-span-3" submitLabel="创建补发并锁定库存"><input name="orderId" type="hidden" value={order.id} /><input name="shipmentId" type="hidden" value={shipment.id} /><div><p className="flex items-center gap-2 text-sm font-semibold text-ink"><PackageCheck className="size-4" />创建补发</p><p className="mt-1 text-xs text-muted">只可选择原包裹 SKU，填 0 表示不补发。</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shipment.lines.map((line) => <label className="space-y-1 text-xs text-muted" key={line.id}>{line.skuCode}（原 {line.quantity} 件）<Input defaultValue="0" inputMode="numeric" max={line.quantity} min="0" name={`quantity:${line.skuId}`} type="number" /></label>)}</div><Input maxLength={1000} name="reason" placeholder="填写补发原因，例如：运输破损" required /><label className="flex items-start gap-2 text-xs text-muted"><input className="mt-0.5" required type="checkbox" />我确认补发将立即锁定所选库存</label></ActionForm> : null}
              </div> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
