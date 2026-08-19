import { PackageSearch } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { AdminOrderCancel } from "@/components/orders/admin-order-cancel";
import { OrderFilterBar } from "@/components/orders/order-filter-bar";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  { label: "待仓库发货", value: "FULFILLING" },
  { label: "仓库已发货", value: "SHIPPED" },
  { label: "仓库处理异常", value: "FULFILLMENT_EXCEPTION" },
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

  const [orders, options] = await Promise.all([listAdminOrders(filters), listAdminOrderFilterOptions()]);
  const isCancelledView = filters.status === "CANCELLED";
  const pendingPaymentCount = orders.filter((order) => order.status === "PENDING_PAYMENT").length;
  const exceptionCount = orders.filter((order) => order.status === "FULFILLMENT_EXCEPTION").length;
  const totalAmountFen = orders.reduce((sum, order) => sum + order.totalAmountFen, 0);

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <Button asChild variant="outline">
            <Link href={isCancelledView ? "/admin/orders" : "/admin/orders?status=CANCELLED"}>
              {isCancelledView ? "返回有效拿货单" : "查看已取消拿货单"}
            </Link>
          </Button>
        }
        description={
          isCancelledView
            ? "已取消拿货单仅用于审计追溯，不计入有效订单数量和经营金额。"
            : "按客户、店铺、状态和日期查询有效拿货单；已取消记录单独归档。"
        }
        title={isCancelledView ? "已取消拿货单" : "订单管理"}
      />

      <MetricStrip
        items={
          isCancelledView
            ? [
                { hint: "当前归档筛选下的取消记录", label: "已取消订单", value: String(orders.length) },
                { hint: "取消记录中的原包裹数", label: "原包裹数", value: String(orders.reduce((sum, order) => sum + order.totalPackageCount, 0)) },
                { hint: "取消记录中的原商品件数", label: "原商品件数", value: String(orders.reduce((sum, order) => sum + order.totalQuantity, 0)) },
                { hint: "仅供审计，不计入经营金额", label: "取消前金额", value: money(totalAmountFen) },
              ]
            : [
                { hint: "当前筛选条件下的有效订单数", label: "订单总数", value: String(orders.length) },
                { hint: "等待客户线下付款", label: "待付款", tone: pendingPaymentCount ? "warning" : "default", value: String(pendingPaymentCount) },
                { hint: "需要人工核查仓库处理问题", label: "仓库处理异常", tone: exceptionCount ? "danger" : "default", value: String(exceptionCount) },
                { hint: "当前有效筛选结果的订单金额", label: "订单金额", value: money(totalAmountFen) },
              ]
        }
      />

      <OrderFilterBar
        customerOptions={options.customers.map((customer) => ({
          label: `${customer.code} · ${customer.name}`,
          value: customer.id,
        }))}
        statusOptions={statuses}
        storeOptions={options.stores.map((store) => ({ label: store.name, value: store.id }))}
        values={filters}
      />

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          action={<PackageSearch className="size-4 text-primary" />}
          description={`当前条件共 ${orders.length} 条，最多显示 500 条。`}
          title={isCancelledView ? "已取消拿货单" : "拿货单"}
        />
        <div className="hidden md:block">
          <ResponsiveDataTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>拿货单 / 时间</TableHead>
                  <TableHead>客户 / 店铺</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length ? (
                  orders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell>
                        <Link className="font-semibold text-primary hover:underline" href={`/admin/orders/${order.id}`}>
                          {order.orderNumber}
                        </Link>
                        <p className="mt-1 text-xs text-muted">{dateTime(order.createdAt)}</p>
                      </TableCell>
                      <TableCell>
                        <p>
                          {order.customerCode} · {order.customerName}
                        </p>
                        <p className="mt-1 text-xs text-muted">{order.storeName}</p>
                      </TableCell>
                      <TableCell>
                        <Badge className={badgeClass(order.status)} variant="secondary">
                          {statuses.find((status) => status.value === order.status)?.label}
                        </Badge>
                        {order.lockExpiresAt ? <p className="mt-1 text-xs text-muted">锁定至 {dateTime(order.lockExpiresAt)}</p> : null}
                      </TableCell>
                      <TableCell>
                        {order.totalPackageCount} 包 / {order.totalQuantity} 件
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{money(order.totalAmountFen)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/orders/${order.id}`}>详情</Link>
                          </Button>
                          {canCancel(order.status) ? <AdminOrderCancel orderId={order.id} /> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell className="h-28 text-center text-muted" colSpan={6}>
                      没有符合条件的拿货单。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ResponsiveDataTable>
        </div>

        <div className="divide-y divide-border md:hidden">
          {orders.length ? (
            orders.map((order) => (
              <article
                aria-label={`订单 ${order.orderNumber}`}
                className="space-y-3 p-4"
                data-mobile-order-card
                data-workspace-panel
                key={order.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link className="font-semibold text-primary" href={`/admin/orders/${order.id}`}>
                      {order.orderNumber}
                    </Link>
                    <p className="mt-1 text-xs text-muted">{dateTime(order.createdAt)}</p>
                  </div>
                  <Badge className={badgeClass(order.status)} variant="secondary">
                    {statuses.find((status) => status.value === order.status)?.label}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted">客户 / 店铺</p>
                    <p className="mt-1 text-ink">
                      {order.customerCode} · {order.storeName}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">数量 / 金额</p>
                    <p className="mt-1 font-semibold text-ink">
                      {order.totalQuantity} 件 · {money(order.totalAmountFen)}
                    </p>
                  </div>
                </div>
                {order.lockExpiresAt ? <p className="text-xs text-muted">库存锁定至 {dateTime(order.lockExpiresAt)}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button asChild className="min-h-11" size="sm" variant="outline">
                    <Link href={`/admin/orders/${order.id}`}>查看履约详情</Link>
                  </Button>
                  {canCancel(order.status) ? <AdminOrderCancel orderId={order.id} /> : null}
                </div>
              </article>
            ))
          ) : (
            <div className="p-10 text-center text-sm text-muted">没有符合条件的拿货单。</div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
