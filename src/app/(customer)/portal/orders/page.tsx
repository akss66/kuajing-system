import { ArrowRight, ClipboardList } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { OrderFilterBar } from "@/components/orders/order-filter-bar";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { listCustomerOrders, type AdminOrderStatus } from "@/modules/orders/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const labels = {
  PENDING_PAYMENT: "待付款",
  PAID_PENDING_FULFILLMENT: "已付款，待发货",
  FULFILLING: "仓库处理中",
  SHIPPED: "已发货",
  FULFILLMENT_EXCEPTION: "需要协助",
  CANCELLED: "已取消",
  EXPIRED: "已超时",
} as const;

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function value(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

function localDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(value);
}

function nextAction(status: keyof typeof labels) {
  if (status === "PENDING_PAYMENT") return "去付款";
  if (status === "FULFILLMENT_EXCEPTION") return "查看详情";
  if (status === "SHIPPED") return "查看物流";
  return "查看进度";
}

export default async function CustomerOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireCustomer();
  const raw = await searchParams;
  const selectedStatus = value(raw.status);
  const filters = {
    dateFrom: value(raw.dateFrom),
    dateTo: value(raw.dateTo),
    orderNumber: value(raw.orderNumber),
    status: selectedStatus && selectedStatus in labels ? selectedStatus : undefined,
  };
  const pendingOnly = filters.status === "PENDING_PAYMENT";
  const isCancelledView = filters.status === "CANCELLED";
  const isExpiredView = filters.status === "EXPIRED";
  const isHistoricalView = isCancelledView || isExpiredView;
  const historyLabel = isExpiredView ? "超时" : "取消";
  const allOrders = await listCustomerOrders(
    principal.customerId,
    filters.status as AdminOrderStatus | undefined,
  );
  const orders = allOrders.filter((order) => {
    if (filters.status && order.status !== filters.status) return false;
    if (filters.orderNumber && !order.orderNumber.toLocaleLowerCase().includes(filters.orderNumber.toLocaleLowerCase())) {
      return false;
    }
    const createdDate = localDate(order.createdAt);
    if (filters.dateFrom && createdDate < filters.dateFrom) return false;
    if (filters.dateTo && createdDate > filters.dateTo) return false;
    return true;
  });

  const totalAmountFen = orders.reduce(
    (sum, order) =>
      sum +
      (isHistoricalView
        ? order.totalAmountFen
        : (order.netAmountFen ?? order.totalAmountFen)),
    0,
  );
  const totalPackages = orders.reduce(
    (sum, order) => sum + order.totalPackageCount,
    0,
  );
  const totalQuantity = orders.reduce(
    (sum, order) => sum + order.totalQuantity,
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/portal", label: "经营概览" },
          {
            label: pendingOnly
              ? "待付款订单"
              : isHistoricalView
                ? `已${historyLabel}拿货单`
                : "我的订单",
          },
        ]}
        description={
          pendingOnly
            ? "这里只显示等待线下付款的订单，便于统一进入付款结算。"
            : isHistoricalView
              ? `已${historyLabel}拿货单仅用于历史追溯，不计入有效订单数量和金额。`
            : "查看订单金额、包裹数量、付款状态与后续履约进度。"
        }
        title={
          pendingOnly
            ? "待付款订单"
            : isHistoricalView
              ? `已${historyLabel}拿货单`
              : "我的订单"
        }
      />

      <MetricStrip
        items={
          isHistoricalView
            ? [
                {
                  hint: `当前筛选下的历史${historyLabel}记录`,
                  label: `已${historyLabel}订单`,
                  value: `${orders.length}`,
                },
                { hint: `${historyLabel}记录中的原包裹数`, label: "原包裹数", value: `${totalPackages}` },
                { hint: `${historyLabel}记录中的原商品件数`, label: "原商品件数", value: `${totalQuantity}` },
                {
                  hint: "仅供历史核对，不计入有效订单金额",
                  label: `${historyLabel}前金额`,
                  value: money(totalAmountFen),
                },
              ]
            : [
                { label: "订单数", value: `${orders.length}` },
                { label: "包裹数", value: `${totalPackages}` },
                { label: "商品件数", value: `${totalQuantity}` },
                { label: "订单总额", value: money(totalAmountFen) },
              ]
        }
      />

      <OrderFilterBar
        audience="customer"
        statusOptions={Object.entries(labels).map(([status, label]) => ({ label, value: status }))}
        values={filters}
      />

      <section className="space-y-3" aria-labelledby="customer-order-list-title">
        <div>
          <h2 className="text-base font-semibold text-foreground" id="customer-order-list-title">
            {pendingOnly ? "待付款清单" : isHistoricalView ? `已${historyLabel}拿货单` : "订单列表"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">点击任一订单可查看付款记录、库存锁定与明细状态。</p>
        </div>
        {orders.length ? (
          <div className="grid gap-3">
            {orders.map((order) => {
              const action = nextAction(order.status);
              return (
                <article
                  aria-label={`订单 ${order.orderNumber}`}
                  className="group rounded-2xl bg-white p-4 shadow-[0_2px_12px_rgb(0_0_0/0.02)] transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-lg sm:p-5"
                  data-mobile-order-card
                  key={order.id}
                >
                  <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-hover">
                      <ClipboardList aria-hidden="true" className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="break-all text-ink">{order.orderNumber}</strong>
                        <Badge variant="secondary">{labels[order.status]}</Badge>
                        {order.cancellationState === "PARTIAL" ? <Badge className="bg-warning/10 text-warning" variant="secondary">部分取消</Badge> : null}
                      </span>
                      <span className="mt-1 block text-sm text-slate-500">
                        <span>{order.storeName}</span>
                        <span> · {order.totalPackageCount} 包 · {order.totalQuantity} 件</span>
                      </span>
                      <span className="mt-2 block text-xs font-medium text-slate-600">下一步：{action}</span>
                    </span>
                    <span className="flex shrink-0 items-center justify-between gap-4 sm:flex-col sm:items-end sm:text-right">
                      <strong className="block text-lg font-semibold tabular-nums text-ink">{money(isHistoricalView ? order.totalAmountFen : (order.netAmountFen ?? order.totalAmountFen))}</strong>
                      <Link className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm font-semibold text-primary-hover transition-colors hover:bg-primary-soft" href={`/portal/orders/${order.id}`}>
                        {action}<ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-1" />
                      </Link>
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <ActionableEmptyState
            description={pendingOnly ? "余额自动扣款的订单不会出现在这里。" : "上传订单并确认提交后，会显示在这里。"}
            kind="initial"
            title={pendingOnly ? "没有待付款订单" : "暂无拿货单"}
          />
        )}
      </section>
    </div>
  );
}
