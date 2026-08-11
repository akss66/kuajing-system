import { Filter, PackageSearch } from "lucide-react";
import Link from "next/link";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { AdminOrderCancel } from "@/components/orders/admin-order-cancel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  listAdminOrderFilterOptions,
  listAdminOrders,
  type AdminOrderFilters,
  type AdminOrderStatus,
} from "@/modules/orders/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const statuses: Array<{ label: string; value: AdminOrderStatus }> = [
  { label: "待付款", value: "PENDING_PAYMENT" },
  { label: "已付款 / 待发货", value: "PAID_PENDING_FULFILLMENT" },
  { label: "履约中", value: "FULFILLING" },
  { label: "已发货", value: "SHIPPED" },
  { label: "履约异常", value: "FULFILLMENT_EXCEPTION" },
  { label: "已取消", value: "CANCELLED" },
  { label: "已超时", value: "EXPIRED" },
];

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

function badgeClass(status: AdminOrderStatus) {
  if (status === "FULFILLMENT_EXCEPTION") return "bg-danger/10 text-danger";
  if (status === "PAID_PENDING_FULFILLMENT" || status === "SHIPPED") return "bg-success/10 text-success";
  if (status === "PENDING_PAYMENT") return "bg-warning/10 text-warning";
  return "bg-surface-muted text-muted";
}

function canCancel(status: AdminOrderStatus) {
  return status === "PENDING_PAYMENT" || status === "PAID_PENDING_FULFILLMENT";
}

function value(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const selectedStatus = value(raw.status);
  const filters: AdminOrderFilters = {
    customerId: value(raw.customerId),
    dateFrom: value(raw.dateFrom),
    dateTo: value(raw.dateTo),
    orderNumber: value(raw.orderNumber),
    status: statuses.some((status) => status.value === selectedStatus)
      ? (selectedStatus as AdminOrderStatus)
      : undefined,
    storeId: value(raw.storeId),
  };
  const [orders, options] = await Promise.all([
    listAdminOrders(filters),
    listAdminOrderFilterOptions(),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-primary">履约工作台</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">订单管理</h1>
        <p className="mt-2 text-sm text-muted">按客户、店铺、状态和日期查询拿货单；履约异常与已超时订单优先显示。</p>
      </header>

      <form className="grid gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 xl:grid-cols-[1.1fr_1fr_1fr_1fr_0.8fr_0.8fr_auto_auto] xl:items-end">
        <label className="space-y-2 text-sm font-medium text-ink">拿货单号<Input className="min-h-11" defaultValue={filters.orderNumber} name="orderNumber" placeholder="输入完整或部分单号" /></label>
        <label className="space-y-2 text-sm font-medium text-ink">状态<select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue={filters.status ?? ""} name="status"><option value="">全部状态</option>{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
        <label className="space-y-2 text-sm font-medium text-ink">客户<select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue={filters.customerId ?? ""} name="customerId"><option value="">全部客户</option>{options.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} · {customer.name}</option>)}</select></label>
        <label className="space-y-2 text-sm font-medium text-ink">店铺<select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue={filters.storeId ?? ""} name="storeId"><option value="">全部店铺</option>{options.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <label className="space-y-2 text-sm font-medium text-ink">开始日期<Input className="min-h-11" defaultValue={filters.dateFrom} name="dateFrom" type="date" /></label>
        <label className="space-y-2 text-sm font-medium text-ink">结束日期<Input className="min-h-11" defaultValue={filters.dateTo} name="dateTo" type="date" /></label>
        <Button className="min-h-11 px-4" type="submit"><Filter />筛选</Button>
        <Button asChild className="min-h-11 px-4" variant="outline"><Link href="/admin/orders">清空</Link></Button>
      </form>

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
          <div><h2 className="font-semibold text-ink">拿货单</h2><p className="mt-1 text-sm text-muted">当前条件共 {orders.length} 条，最多显示 500 条。</p></div>
          <PackageSearch className="size-5 text-primary" />
        </div>
        <div className="hidden md:block">
          <ResponsiveDataTable>
            <Table>
              <TableHeader><TableRow><TableHead>拿货单 / 时间</TableHead><TableHead>客户 / 店铺</TableHead><TableHead>状态</TableHead><TableHead>数量</TableHead><TableHead className="text-right">金额</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
              <TableBody>{orders.length ? orders.map((order) => <TableRow key={order.id}><TableCell><Link className="font-semibold text-primary hover:underline" href={`/admin/orders/${order.id}`}>{order.orderNumber}</Link><p className="mt-1 text-xs text-muted">{dateTime(order.createdAt)}</p></TableCell><TableCell><p>{order.customerCode} · {order.customerName}</p><p className="mt-1 text-xs text-muted">{order.storeName}</p></TableCell><TableCell><Badge className={badgeClass(order.status)} variant="secondary">{statuses.find((status) => status.value === order.status)?.label}</Badge>{order.lockExpiresAt ? <p className="mt-1 text-xs text-muted">锁定至 {dateTime(order.lockExpiresAt)}</p> : null}</TableCell><TableCell>{order.totalPackageCount} 包 / {order.totalQuantity} 件</TableCell><TableCell className="text-right font-semibold tabular-nums">{money(order.totalAmountFen)}</TableCell><TableCell><div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link href={`/admin/orders/${order.id}`}>详情</Link></Button>{canCancel(order.status) ? <AdminOrderCancel orderId={order.id} /> : null}</div></TableCell></TableRow>) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={6}>没有符合条件的拿货单。</TableCell></TableRow>}</TableBody>
            </Table>
          </ResponsiveDataTable>
        </div>
        <div className="divide-y divide-border md:hidden">
          {orders.length ? orders.map((order) => <article className="space-y-3 p-4" key={order.id}><div className="flex items-start justify-between gap-3"><div><Link className="font-semibold text-primary" href={`/admin/orders/${order.id}`}>{order.orderNumber}</Link><p className="mt-1 text-xs text-muted">{dateTime(order.createdAt)}</p></div><Badge className={badgeClass(order.status)} variant="secondary">{statuses.find((status) => status.value === order.status)?.label}</Badge></div><div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted">客户 / 店铺</p><p className="mt-1 text-ink">{order.customerCode} · {order.storeName}</p></div><div><p className="text-xs text-muted">数量 / 金额</p><p className="mt-1 font-semibold text-ink">{order.totalQuantity} 件 · {money(order.totalAmountFen)}</p></div></div>{order.lockExpiresAt ? <p className="text-xs text-muted">库存锁定至 {dateTime(order.lockExpiresAt)}</p> : null}<div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link href={`/admin/orders/${order.id}`}>查看履约详情</Link></Button>{canCancel(order.status) ? <AdminOrderCancel orderId={order.id} /> : null}</div></article>) : <div className="p-10 text-center text-sm text-muted">没有符合条件的拿货单。</div>}
        </div>
      </section>
    </div>
  );
}
