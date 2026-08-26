import { ArrowLeft, Box, CircleAlert, PackageCheck, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { OrderStatusTimeline } from "@/components/orders/order-status-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cancelAllCancellableOrderShipmentsAction,
  cancelJifengShipmentAction,
  completeAllOfflineOrderRefundsAction,
  completeOfflinePackageRefundAction,
  createReplacementAction,
  refreshAllJifengShipmentStatusesAction,
  refreshJifengShipmentStatusAction,
  retryJifengShipmentAction,
} from "@/modules/fulfillment/actions";
import { safeFulfillmentError } from "@/modules/fulfillment/fulfillment-ui-labels";
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
  PENDING: "等待匹配极风订单",
  SHIPPED: "仓库已发货",
  SUBMITTED: "已匹配极风订单",
  SUBMITTING: "正在匹配极风订单",
};

const MANUAL_RETRY_QUEUED = "MANUAL_CONFIRMED_FAILURE_RETRY";

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

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function totalLineQuantity(
  lines: Array<{
    quantity: number;
  }>,
) {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
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
  const refreshableShipmentCount = order.shipments.filter((shipment) =>
    [
      "SUBMITTED",
      "FULFILLING",
      "EXCEPTION",
      "CANCEL_PENDING",
      "CANCELLED",
      "SHIPPED",
    ].includes(shipment.fulfillmentStatus ?? ""),
  ).length;
  const pendingOfflineRefunds = order.shipments.flatMap((shipment) =>
    shipment.cancellationAdjustment?.status === "PENDING_OFFLINE"
      ? [shipment.cancellationAdjustment]
      : [],
  );
  const pendingOfflineRefundAmountFen = pendingOfflineRefunds.reduce(
    (sum, adjustment) => sum + adjustment.offlineAmountFen,
    0,
  );
  const canCancelOrder = !["CANCELLED", "EXPIRED", "SHIPPED"].includes(
    order.status,
  );
  const isPreFulfillmentCancellation = [
    "PENDING_PAYMENT",
    "PAID_PENDING_FULFILLMENT",
  ].includes(order.status);

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
            {order.cancellationState === "PARTIAL" ? <Badge className="w-fit bg-warning/10 px-3 py-1.5 text-warning" variant="secondary">部分取消</Badge> : null}
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
        compact
        columns={5}
        items={[
          { label: "包裹数", value: `${order.shipments.length}` },
          { label: "商品件数", value: `${order.totalQuantity}` },
          { hint: `原始金额 ${money(order.totalAmountFen)}`, label: "当前净额", value: money(order.netAmountFen ?? order.totalAmountFen) },
          { hint: "含被取消包裹商品额与每包 13 元物流费", label: "取消调整", value: `-${money(order.adjustedAmountFen ?? 0)}` },
          { label: "创建时间", value: dateTime(order.createdAt) },
        ]}
      />

      <OrderStatusTimeline
        audience="admin"
        orderStatus={order.status}
        paidAt={order.paidAt}
        refundedAt={order.refundedAt}
        replacementStatuses={order.shipments.map((shipment) => shipment.replacementStatus)}
        shipmentStatuses={order.shipments.map((shipment) => shipment.fulfillmentStatus)}
      />

      <section
        aria-labelledby="order-operations-heading"
        className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-sm font-semibold text-ink" id="order-operations-heading">
              整单操作
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              状态查询与取消按包裹独立处理；整单退款确认则在一个事务中全部成功或全部回滚。
            </p>
          </div>
          <Badge variant="secondary">{order.shipments.length} 个包裹</Badge>
        </div>
        <div className="grid divide-y divide-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <ActionForm
            action={refreshAllJifengShipmentStatusesAction}
            className="flex flex-col gap-3 p-4 sm:p-5"
            submitDisabled={refreshableShipmentCount === 0}
            submitLabel="一键查询整单状态"
          >
            <input name="orderId" type="hidden" value={order.id} />
            <div className="min-h-14">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                <RefreshCcw aria-hidden="true" className="size-4 text-primary" />
                查询全部极风状态
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                当前有 {refreshableShipmentCount} 个包裹可查询；尚未进入极风的包裹会自动跳过。
              </p>
            </div>
          </ActionForm>

          <ConfirmedActionForm
            action={cancelAllCancellableOrderShipmentsAction}
            className="flex flex-col gap-3 p-4 sm:p-5"
            confirmDescription={
              isPreFulfillmentCancellation
                ? "系统会再次校验全部包裹。未进入极风的包裹会直接取消；若已有远端履约，将改为逐包裹安全取消。"
                : "已发货和已取消包裹会跳过，正在取消的包裹会计入等待确认。已绑定极风的包裹必须等远端确认状态 9 后，才会释放库存并生成退款记录。"
            }
            confirmLabel="确认执行整单取消"
            confirmTitle={
              isPreFulfillmentCancellation
                ? "确认取消整个拿货单？"
                : "确认取消全部可取消包裹？"
            }
            disabled={!canCancelOrder}
            submitLabel={
              isPreFulfillmentCancellation
                ? "取消整个拿货单"
                : "取消全部可取消包裹"
            }
          >
            <input name="orderId" type="hidden" value={order.id} />
            <div className="min-h-14">
              <p className="text-sm font-semibold text-ink">
                {isPreFulfillmentCancellation ? "整单取消" : "批量取消包裹"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                不会取消已发货包裹，也不会提前释放远端取消中的库存。
              </p>
            </div>
            <Input
              maxLength={1000}
              name="reason"
              placeholder="填写本次整单取消原因"
              required
            />
          </ConfirmedActionForm>

          <ConfirmedActionForm
            action={completeAllOfflineOrderRefundsAction}
            className="flex flex-col gap-3 p-4 sm:p-5"
            confirmDescription={`将一次确认 ${pendingOfflineRefunds.length} 笔待线下退款，共 ${money(
              pendingOfflineRefundAmountFen,
            )}。完成后不可修改，只能通过审计记录追溯。`}
            confirmLabel="确认全部退款已完成"
            confirmTitle="确认整单线下退款全部完成？"
            disabled={pendingOfflineRefunds.length === 0}
            submitLabel="确认全部退款完成"
            variant="default"
          >
            <input name="orderId" type="hidden" value={order.id} />
            <div className="min-h-14">
              <p className="text-sm font-semibold text-ink">整单退款确认</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                待处理 {pendingOfflineRefunds.length} 笔，共 {money(pendingOfflineRefundAmountFen)}。
              </p>
            </div>
            <Input
              maxLength={1000}
              name="note"
              placeholder="填写退款流水号、时间或批次备注"
              required
            />
          </ConfirmedActionForm>
        </div>
      </section>

      <div className="space-y-5">
        {order.shipments.map((shipment, shipmentIndex) => {
          const canRetry =
            shipment.fulfillmentStatus === "EXCEPTION" &&
            shipment.jifengStatus === null;
          const canRefresh =
            ["SUBMITTED", "FULFILLING", "CANCEL_PENDING"].includes(shipment.fulfillmentStatus ?? "") ||
            (shipment.fulfillmentStatus === "EXCEPTION" &&
              shipment.jifengStatus !== null) ||
            (shipment.fulfillmentStatus === "CANCELLED" &&
              (order.status === "FULFILLMENT_EXCEPTION" ||
                !shipment.cancellationAdjustment));
          const canCancel = shipment.fulfillmentStatus !== null && !["SHIPPED", "CANCELLED", "CANCEL_PENDING"].includes(shipment.fulfillmentStatus);
          const canReplace = shipment.kind === "NORMAL" && shipment.fulfillmentStatus === "SHIPPED";
          const retryQueued = shipment.lastErrorCode === MANUAL_RETRY_QUEUED;
          const waitingForMatch =
            shipment.fulfillmentStatus === "PENDING" &&
            ["50017", "50071"].includes(shipment.lastErrorCode ?? "");
          const errorPresentation = shipment.lastErrorCode
            ? safeFulfillmentError(shipment.lastErrorCode, shipment.lastErrorMessage)
            : null;
          const packageLabel =
            shipment.kind === "REPLACEMENT"
              ? "补发包裹"
              : `普通包裹 ${shipmentIndex + 1}`;
          const packageSummary = `${shipment.lines.length} 个 SKU · ${totalLineQuantity(shipment.lines)} 件`;
          const openOperationsByDefault =
            shipment.fulfillmentStatus === "EXCEPTION" ||
            shipment.fulfillmentStatus === "CANCEL_PENDING" ||
            (shipment.fulfillmentStatus === "CANCELLED" &&
              order.status === "FULFILLMENT_EXCEPTION");
          const openPackageByDefault =
            openOperationsByDefault ||
            waitingForMatch ||
            retryQueued ||
            Boolean(shipment.cancellationAdjustment);
          return (
            <details
              aria-label={`${packageLabel}工作区`}
              className="group/shipment overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"
              key={shipment.id}
              open={openPackageByDefault}
            >
              <summary className="list-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <div className="px-4 py-3 sm:px-5">
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] lg:items-center">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                      <Box className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold text-ink">{packageLabel}</h2>
                        <span className="text-xs text-muted">{packageSummary}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted">平台订单 {shipment.externalOrderNo}</p>
                    </div>
                  </div>
                  <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-sm lg:grid-cols-1">
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted">极风 ERP 单号</dt>
                      <dd className="truncate font-medium text-ink">{shipment.erpNo ?? "—"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted">加拿大邮政运单</dt>
                      <dd className="truncate font-medium text-ink">{shipment.trackingNumber ?? "—"}</dd>
                    </div>
                  </dl>
                  <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-sm lg:grid-cols-1">
                    <div>
                      <dt className="text-[11px] text-muted">极风状态 / 调用</dt>
                      <dd className="font-medium text-ink">
                        {shipment.jifengStatus ?? "—"} · {shipment.attemptCount ?? 0} 次
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-muted">下次重试</dt>
                      <dd className="font-medium text-ink">{dateTime(shipment.nextRetryAt)}</dd>
                    </div>
                  </dl>
                  <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-end">
                    <Badge className={statusClass(shipment.fulfillmentStatus)} variant="secondary">
                      {statusLabels[shipment.fulfillmentStatus ?? ""] ?? "尚未进入极风"}
                    </Badge>
                    <span className="text-xs text-muted group-open/shipment:hidden">展开详情</span>
                    <span className="hidden text-xs text-muted group-open/shipment:block">收起详情</span>
                  </div>
                  </div>
                </div>

                {shipment.lastErrorCode ? (
                  <div
                    className={`flex gap-3 border-t px-4 py-3 text-sm sm:px-5 ${
                      retryQueued || waitingForMatch
                        ? "border-primary/20 bg-primary-soft text-primary-hover"
                        : "border-danger/20 bg-danger/5 text-danger"
                    }`}
                  >
                    {retryQueued || waitingForMatch ? (
                      <RefreshCcw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    )}
                    <div>
                      <p className="font-semibold">{errorPresentation?.title}</p>
                      <p className="mt-1">{errorPresentation?.message}</p>
                    </div>
                  </div>
                ) : null}
              </summary>

              <div className="grid gap-4 border-t border-border bg-surface/28 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
                <section aria-label={`${packageLabel}商品`}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-ink">包裹商品</h3>
                    <span className="text-xs text-muted">{packageSummary}</span>
                  </div>
                  <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-background">
                    {shipment.lines.map((line) => (
                      <div
                        className="grid grid-cols-[1fr_auto] gap-4 px-3 py-3 text-sm sm:grid-cols-[1fr_0.7fr_auto]"
                        key={line.id}
                      >
                        <div>
                          <p className="font-medium text-ink">{line.skuCode}</p>
                          <p className="mt-0.5 text-xs text-muted">{line.skuName}</p>
                        </div>
                        <p className="hidden self-center text-muted sm:block">
                          {formatMilliYuan(line.unitPriceMilliYuan)} / 件
                        </p>
                        <p className="self-center font-semibold tabular-nums">× {line.quantity}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section aria-label={`${packageLabel}履约信息`} className="space-y-4">
                  <div className="rounded-lg border border-border bg-background p-4">
                    <h3 className="text-sm font-semibold text-ink">履约信息</h3>
                    <dl className="mt-3 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-muted">物流费用</dt>
                        <dd className="mt-1 font-medium text-ink">
                          {fee(shipment.logisticsFeeMinor, shipment.logisticsCurrency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">发货时间</dt>
                        <dd className="mt-1 font-medium text-ink">{dateTime(shipment.shippedAt)}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-muted">补发状态 / 原因</dt>
                        <dd className="mt-1 font-medium text-ink">
                          {shipment.replacementStatus === "FULFILLING"
                            ? "补发待仓库发货"
                            : shipment.replacementStatus === "SHIPPED"
                              ? "补发仓库已发货"
                              : shipment.replacementStatus
                                ? formatReplacementStatus(shipment.replacementStatus)
                                : "—"}
                          {shipment.replacementReason
                            ? ` · ${shipment.replacementReason}`
                            : ""}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  {shipment.cancellationAdjustment ? (
                    <div className="rounded-lg border border-warning/20 bg-warning/5 p-4 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-ink">取消金额调整</p>
                          <p className="mt-1 text-muted">
                            商品{" "}
                            {money(
                              shipment.cancellationAdjustment.merchandiseAmountFen,
                            )}{" "}
                            + 物流费{" "}
                            {money(
                              shipment.cancellationAdjustment.shippingFeeFen,
                            )}{" "}
                            ={" "}
                            {money(shipment.cancellationAdjustment.totalAmountFen)}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            钱包退回{" "}
                            {money(
                              shipment.cancellationAdjustment.walletAmountFen,
                            )}{" "}
                            · 线下退款{" "}
                            {money(
                              shipment.cancellationAdjustment.offlineAmountFen,
                            )}
                          </p>
                        </div>
                        <Badge className="bg-warning/10 text-warning" variant="secondary">
                          {shipment.cancellationAdjustment.status === "NOT_PAID"
                            ? "未付款，已冲减应付"
                            : shipment.cancellationAdjustment.status ===
                                "PENDING_OFFLINE"
                              ? "待确认线下退款"
                              : "退款处理完成"}
                        </Badge>
                      </div>
                      {shipment.cancellationAdjustment.status === "PENDING_OFFLINE" ? (
                        <ActionForm
                          action={completeOfflinePackageRefundAction}
                          className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
                          submitLabel="确认线下退款完成"
                        >
                          <input
                            name="adjustmentId"
                            type="hidden"
                            value={shipment.cancellationAdjustment.id}
                          />
                          <label className="space-y-1 text-xs font-medium text-ink">
                            退款凭证或备注
                            <Input
                              maxLength={1000}
                              name="note"
                              placeholder="例如：微信退款流水号与退款时间"
                              required
                            />
                          </label>
                        </ActionForm>
                      ) : shipment.cancellationAdjustment.offlineCompletedAt ? (
                        <p className="mt-3 text-xs text-muted">
                          线下退款完成于{" "}
                          {dateTime(
                            shipment.cancellationAdjustment.offlineCompletedAt,
                          )}
                          {shipment.cancellationAdjustment.offlineCompletionNote
                            ? ` · ${shipment.cancellationAdjustment.offlineCompletionNote}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </div>

              {canRetry || canRefresh || canCancel || canReplace ? (
                <div className="border-t border-border px-4 py-4 sm:px-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-ink">处理此包裹</h3>
                    <span className="text-xs text-muted">仅影响当前包裹，不影响同单其他包裹</span>
                  </div>
                  <div className="mt-4 grid gap-4 lg:grid-cols-3">
                    {canRetry ? (
                      <ActionForm
                        action={retryJifengShipmentAction}
                        className="space-y-3 rounded-lg border border-border bg-background p-4"
                        submitLabel="重试这个包裹"
                      >
                        <input name="orderId" type="hidden" value={order.id} />
                        <input name="shipmentId" type="hidden" value={shipment.id} />
                        <div>
                          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                            <RefreshCcw className="size-4" />
                            重试这个包裹
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            只重新处理当前平台订单，不影响同一拿货单的其他包裹。
                          </p>
                        </div>
                        <Input maxLength={1000} name="reason" placeholder="填写重试原因" required />
                        <label className="flex items-start gap-2 text-xs text-muted">
                          <input className="mt-0.5" required type="checkbox" />
                          我已核对错误信息并确认重试
                        </label>
                      </ActionForm>
                    ) : null}
                    {canRefresh ? (
                      <ActionForm
                        action={refreshJifengShipmentStatusAction}
                        className="space-y-3 rounded-lg border border-border bg-background p-4"
                        submitLabel={
                          shipment.fulfillmentStatus === "CANCELLED"
                            ? "重新核对取消状态"
                            : "重新查询极风状态"
                        }
                      >
                        <input name="shipmentId" type="hidden" value={shipment.id} />
                        <div>
                          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                            <RefreshCcw className="size-4" />
                            {shipment.fulfillmentStatus === "CANCELLED"
                              ? "修复父单进度"
                              : "重新查询极风状态"}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            直接读取极风当前结果并更新本包裹；不会重复创建订单。
                          </p>
                        </div>
                        <label className="flex items-start gap-2 text-xs text-muted">
                          <input className="mt-0.5" required type="checkbox" />
                          我确认立即向极风查询当前状态
                        </label>
                      </ActionForm>
                    ) : null}
                    {canCancel ? (
                      <ActionForm
                        action={cancelJifengShipmentAction}
                        className="space-y-3 rounded-lg border border-border bg-background p-4"
                        submitLabel="取消此包裹"
                      >
                        <input name="orderId" type="hidden" value={order.id} />
                        <input name="shipmentId" type="hidden" value={shipment.id} />
                        <div>
                          <p className="text-sm font-semibold text-ink">取消此包裹</p>
                          <p className="mt-1 text-xs text-muted">
                            尚未绑定极风订单时直接本地取消；已绑定时，确认极风取消后再释放库存。其他包裹不受影响。
                          </p>
                        </div>
                        <Input maxLength={1000} name="reason" placeholder="填写取消原因" required />
                        <label className="flex items-start gap-2 text-xs text-muted">
                          <input className="mt-0.5" required type="checkbox" />
                          我确认只取消当前平台订单对应的包裹
                        </label>
                      </ActionForm>
                    ) : null}
                    {canReplace ? (
                      <ActionForm
                        action={createReplacementAction}
                        className="space-y-3 rounded-lg border border-border bg-background p-4 lg:col-span-3"
                        submitLabel="创建补发并锁定库存"
                      >
                        <input name="orderId" type="hidden" value={order.id} />
                        <input name="shipmentId" type="hidden" value={shipment.id} />
                        <div>
                          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                            <PackageCheck className="size-4" />
                            创建补发
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            只可选择原包裹 SKU，填 0 表示不补发。
                          </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {shipment.lines.map((line) => (
                            <label className="space-y-1 text-xs text-muted" key={line.id}>
                              {line.skuCode}（原 {line.quantity} 件）
                              <Input
                                defaultValue="0"
                                inputMode="numeric"
                                max={line.quantity}
                                min="0"
                                name={`quantity:${line.skuId}`}
                                type="number"
                              />
                            </label>
                          ))}
                        </div>
                        <Input
                          maxLength={1000}
                          name="reason"
                          placeholder="填写补发原因，例如：运输破损"
                          required
                        />
                        <label className="flex items-start gap-2 text-xs text-muted">
                          <input className="mt-0.5" required type="checkbox" />
                          我确认补发将立即锁定所选库存
                        </label>
                      </ActionForm>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
    </div>
  );
}
