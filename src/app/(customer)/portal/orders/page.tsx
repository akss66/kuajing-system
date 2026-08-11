import { ArrowRight, ClipboardList } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { listCustomerOrders } from "@/modules/orders/queries";

const labels = { PENDING_PAYMENT: "待付款", PAID_PENDING_FULFILLMENT: "已付款/待发货", FULFILLING: "履约中", SHIPPED: "已发货", FULFILLMENT_EXCEPTION: "履约异常", CANCELLED: "已取消", EXPIRED: "已超时" } as const;
function money(fen: number) { return `¥${(fen / 100).toFixed(2)}`; }

export default async function CustomerOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const principal = await requireCustomer();
  const pendingOnly = (await searchParams).status === "PENDING_PAYMENT";
  const orders = await listCustomerOrders(principal.customerId, pendingOnly ? "PENDING_PAYMENT" : undefined);
  return <div className="space-y-6"><header><p className="text-sm font-medium text-primary">拿货记录</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{pendingOnly ? "待付款" : "我的订单"}</h1><p className="mt-2 text-sm text-muted">{pendingOnly ? "仅显示等待线下付款的拿货单。" : "查看付款、库存锁定和后续发货状态。"}</p></header><section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">{orders.length ? <div className="divide-y divide-border">{orders.map((order) => <Link className="flex min-h-20 items-center gap-4 p-4 transition-colors hover:bg-surface sm:px-5" href={`/portal/orders/${order.id}`} key={order.id}><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-hover"><ClipboardList className="size-5" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><strong className="text-ink">{order.orderNumber}</strong><Badge variant="secondary">{labels[order.status]}</Badge></span><span className="mt-1 block text-sm text-muted">{order.storeName} · {order.totalPackageCount} 包裹 · {order.totalQuantity} 件</span></span><span className="shrink-0 text-right"><strong className="block tabular-nums text-ink">{money(order.totalAmountFen)}</strong><ArrowRight className="ml-auto mt-2 size-4 text-primary" /></span></Link>)}</div> : <div className="px-5 py-16 text-center"><p className="font-medium text-ink">{pendingOnly ? "没有待付款订单" : "暂无拿货单"}</p><p className="mt-1 text-sm text-muted">{pendingOnly ? "余额足够自动扣款的订单不会出现在这里。" : "上传 TEMU 订单并确认提交后会显示在这里。"}</p></div>}</section></div>;
}
