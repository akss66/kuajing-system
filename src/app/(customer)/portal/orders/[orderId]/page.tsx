import { ArrowLeft, PackageCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CustomerOrderActions } from "@/components/orders/customer-order-actions";
import { OrderStatusPanel } from "@/components/orders/order-status-panel";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { getCustomerOrderDetail } from "@/modules/orders/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const labels = {
  CANCELLED: "已取消",
  EXPIRED: "已超时",
  FULFILLING: "履约中",
  FULFILLMENT_EXCEPTION: "履约异常",
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
  const order = await getCustomerOrderDetail(
    principal.customerId,
    (await params).orderId,
  );
  if (!order) notFound();

  const paid = ["PAID_PENDING_FULFILLMENT", "FULFILLING", "SHIPPED"].includes(
    order.status,
  );

  return (
    <div className="space-y-6">
      <header>
        <Link
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover"
          href="/portal/orders"
        >
          <ArrowLeft className="size-4" />返回我的订单
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {order.orderNumber}
          </h1>
          <Badge
            className={paid ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}
            variant="secondary"
          >
            {labels[order.status]}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-muted">
          {order.storeName} · 创建于 {dateTime(order.createdAt)}（渥太华）
        </p>
      </header>

      <OrderStatusPanel order={order} />

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          ["实际金额", money(order.totalAmountFen)],
          ["包裹数", String(order.totalPackageCount)],
          ["商品件数", String(order.totalQuantity)],
        ].map(([label, value]) => (
          <article
            className="rounded-[var(--radius-surface)] border border-border bg-background p-4"
            key={label}
          >
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-ink">{value}</p>
          </article>
        ))}
      </section>

      <CustomerOrderActions order={order} />

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="flex items-center gap-3 border-b border-border px-4 py-4 sm:px-5">
          <PackageCheck className="size-5 text-primary" />
          <div>
            <h2 className="font-semibold text-ink">商品明细</h2>
            <p className="mt-1 text-xs text-muted">价格为提交时实际成交价，后续改价不影响本单。</p>
          </div>
        </div>
        <div className="divide-y divide-border">
          {order.lines.map((line) => (
            <article
              className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_90px_110px] sm:items-center sm:px-5"
              key={line.id}
            >
              <div>
                <p className="font-semibold text-ink">{line.skuCode}</p>
                <p className="mt-1 text-xs text-muted">{line.skuName}</p>
              </div>
              <div>
                <p className="text-sm text-ink">店铺 SKU：{line.externalSku}</p>
                <p className="mt-1 break-all text-xs text-muted">子订单：{line.externalSubOrderNo}</p>
              </div>
              <p className="text-sm tabular-nums text-muted sm:text-right">
                {line.quantity} × {money(line.unitPriceFen)}
              </p>
              <p className="font-semibold tabular-nums text-ink sm:text-right">
                {money(line.lineAmountFen)}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
