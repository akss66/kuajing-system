import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { AdminOrderCancel } from "@/components/orders/admin-order-cancel";
import {
  OrderExportCheckbox,
  OrderExportProvider,
  OrderExportToolbar,
} from "@/components/orders/admin-order-export";
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
import {
  canExportOrderToJifeng,
  jifengExportBlockedReason,
} from "@/modules/orders/jifeng-export-policy";
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
  const isExpiredView = filters.status === "EXPIRED";
  const isHistoricalView = isCancelledView || isExpiredView;
  const exportableOrders = isHistoricalView
    ? []
    : orders.filter((order) => canExportOrderToJifeng(order.status));
  const historyLabel = isExpiredView ? "超时" : "取消";
  const pendingPaymentCount = orders.filter((order) => order.status === "PENDING_PAYMENT").length;
  const exceptionCount = orders.filter((order) => order.status === "FULFILLMENT_EXCEPTION").length;
  const totalAmountFen = orders.reduce(
    (sum, order) =>
      sum +
      (isHistoricalView
        ? order.totalAmountFen
        : (order.netAmountFen ?? order.totalAmountFen)),
    0,
  );

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <div className="flex flex-wrap gap-2">
            {!isHistoricalView ? <Button asChild variant="outline"><Link href="/admin/bulk-orders">多店铺上传记录</Link></Button> : null}
            <Button asChild variant="outline">
              <Link href={isHistoricalView ? "/admin/orders" : "/admin/orders?status=CANCELLED"}>
                {isHistoricalView ? "返回有效拿货单" : "查看已取消拿货单"}
              </Link>
            </Button>
          </div>
        }
        description={
          isHistoricalView
            ? `已${historyLabel}拿货单仅用于审计追溯，不计入有效订单数量和经营金额。`
            : "按客户、店铺、状态和日期查询有效拿货单；已取消和已超时记录单独归档。"
        }
        title={isHistoricalView ? `已${historyLabel}拿货单` : "订单管理"}
      />

      <MetricStrip
        items={
          isHistoricalView
            ? [
                { hint: `当前归档筛选下的${historyLabel}记录`, label: `已${historyLabel}订单`, value: String(orders.length) },
                { hint: `${historyLabel}记录中的原包裹数`, label: "原包裹数", value: String(orders.reduce((sum, order) => sum + order.totalPackageCount, 0)) },
                { hint: `${historyLabel}记录中的原商品件数`, label: "原商品件数", value: String(orders.reduce((sum, order) => sum + order.totalQuantity, 0)) },
                { hint: "仅供审计，不计入经营金额", label: `${historyLabel}前金额`, value: money(totalAmountFen) },
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

      <OrderExportProvider orderIds={exportableOrders.map((order) => order.id)}>
        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader
            description={`当前条件共 ${orders.length} 条，最多显示 500 条。`}
            title={isHistoricalView ? `已${historyLabel}拿货单` : "拿货单"}
          />
          {!isHistoricalView ? <OrderExportToolbar /> : null}
        <div className="hidden md:block">
          <ResponsiveDataTable>
            <Table>
              <TableHeader>
                <TableRow>
                  {!isHistoricalView ? <TableHead className="w-10"><span className="sr-only">选择</span></TableHead> : null}
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
                      {!isHistoricalView ? (
                        <TableCell>
                          {canExportOrderToJifeng(order.status) ? (
                            <OrderExportCheckbox orderId={order.id} orderNumber={order.orderNumber} />
                          ) : (
                            <span className="text-xs text-muted">
                              {jifengExportBlockedReason(order.status)}
                            </span>
                          )}
                        </TableCell>
                      ) : null}
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
                        {order.cancellationState === "PARTIAL" ? <Badge className="ml-1 bg-warning/10 text-warning" variant="secondary">部分取消</Badge> : null}
                        {order.lockExpiresAt ? <p className="mt-1 text-xs text-muted">锁定至 {dateTime(order.lockExpiresAt)}</p> : null}
                      </TableCell>
                      <TableCell>
                        {order.totalPackageCount} 包 / {order.totalQuantity} 件
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {money(isHistoricalView ? order.totalAmountFen : (order.netAmountFen ?? order.totalAmountFen))}
                        {(order.adjustedAmountFen ?? 0) > 0 && !isHistoricalView ? <p className="mt-1 text-xs font-normal text-muted">原 {money(order.totalAmountFen)}</p> : null}
                      </TableCell>
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
                    <TableCell className="h-28 text-center text-muted" colSpan={isHistoricalView ? 6 : 7}>
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
                  <div className="flex min-w-0 items-start gap-3">
                    {!isHistoricalView ? (
                      <div className="pt-1">
                        {canExportOrderToJifeng(order.status) ? (
                          <OrderExportCheckbox orderId={order.id} orderNumber={order.orderNumber} />
                        ) : (
                          <span className="text-xs text-muted">
                            {jifengExportBlockedReason(order.status)}
                          </span>
                        )}
                      </div>
                    ) : null}
                    <div className="min-w-0">
                    <Link className="font-semibold text-primary" href={`/admin/orders/${order.id}`}>
                      {order.orderNumber}
                    </Link>
                    <p className="mt-1 text-xs text-muted">{dateTime(order.createdAt)}</p>
                    </div>
                  </div>
                  <Badge className={badgeClass(order.status)} variant="secondary">
                    {statuses.find((status) => status.value === order.status)?.label}
                  </Badge>
                  {order.cancellationState === "PARTIAL" ? <Badge className="bg-warning/10 text-warning" variant="secondary">部分取消</Badge> : null}
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
                      {order.totalQuantity} 件 · {money(isHistoricalView ? order.totalAmountFen : (order.netAmountFen ?? order.totalAmountFen))}
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
      </OrderExportProvider>
    </div>
  );
}
