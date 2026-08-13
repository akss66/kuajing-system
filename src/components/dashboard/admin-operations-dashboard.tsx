import {
  AlertTriangle,
  ArrowRight,
  BanknoteArrowDown,
  Boxes,
  ClipboardCheck,
  FileWarning,
  PackageCheck,
  ReceiptText,
  Route,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";

import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import type { AdminOperationsDashboard as AdminDashboardData } from "@/modules/dashboard/admin-queries";

import { SevenDayTrend } from "./seven-day-trend";

const money = new Intl.NumberFormat("zh-CN", {
  currency: "CNY",
  style: "currency",
});

function SectionHeading({ description, id, title }: { description: string; id: string; title: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground" id={id}>{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function QueueRow({
  count,
  href,
  icon: Icon,
  label,
  tone = "warning",
}: {
  count: number;
  href: string;
  icon: typeof AlertTriangle;
  label: string;
  tone?: "danger" | "warning";
}) {
  return (
    <Link
      className="group flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-surface focus-visible:bg-surface sm:px-5"
      href={href}
    >
      <Icon
        aria-hidden="true"
        className={tone === "danger" ? "size-4 text-danger" : "size-4 text-warning"}
      />
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</span>
      <strong className="tabular-nums text-base text-foreground">{count}</strong>
      <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export function AdminOperationsDashboard({
  dashboard,
}: {
  dashboard: AdminDashboardData;
}) {
  const hasTrend = dashboard.sevenDaySeries.some(
    (point) => point.orderCount > 0 || point.gmvFen > 0,
  );
  const quickActions = [
    { href: "/admin/settlement-batches?status=PAYMENT_REPORTED", icon: ClipboardCheck, label: "审核收款" },
    { href: "/admin/orders?status=FULFILLMENT_EXCEPTION", icon: Route, label: "异常订单" },
    { href: "/admin/inventory", icon: Boxes, label: "库存调整" },
    { href: "/admin/bulk-orders", icon: FileWarning, label: "批量诊断" },
  ];

  return (
    <div className="space-y-7">
      <section aria-labelledby="today-operations-title" className="space-y-3">
        <SectionHeading description="按多伦多自然日统计，不含已取消和已超时订单。" id="today-operations-title" title="今日经营" />
        <WorkspacePanel className="overflow-hidden">
          <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
            {[
              { icon: ShoppingBag, label: "今日订单", value: `${dashboard.todayOrderCount} 单` },
              { icon: ReceiptText, label: "成交金额", value: money.format(dashboard.todayGmvFen / 100) },
              { icon: PackageCheck, label: "今日已发货", value: `${dashboard.todayShippedCount} 单` },
              { icon: Boxes, label: "待发货", value: `${dashboard.pendingFulfillmentCount} 单` },
            ].map((item) => (
              <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:px-5" key={item.label}>
                <item.icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="mt-1 truncate text-xl font-semibold tabular-nums tracking-[-0.02em] text-foreground">
                    {item.value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </WorkspacePanel>
      </section>

      <section aria-labelledby="operations-queue-title" className="space-y-3">
        <SectionHeading description="按资金、履约和数据影响集中排序。" id="operations-queue-title" title="待办与预警" />
        <WorkspacePanel className="overflow-hidden">
          <div className="divide-y divide-border md:grid md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="divide-y divide-border">
              <QueueRow
                count={dashboard.pendingPaymentReviewCount}
                href="/admin/settlement-batches?status=PAYMENT_REPORTED"
                icon={BanknoteArrowDown}
                label="待审核付款"
              />
              <QueueRow
                count={dashboard.fulfillmentExceptionCount}
                href="/admin/orders?status=FULFILLMENT_EXCEPTION"
                icon={AlertTriangle}
                label="履约异常"
                tone="danger"
              />
            </div>
            <div className="divide-y divide-border">
              <QueueRow
                count={dashboard.criticalStockCount}
                href="/admin/inventory"
                icon={Boxes}
                label="库存不足 30 天"
              />
              <QueueRow
                count={dashboard.importExceptionCount}
                href="/admin/bulk-orders"
                icon={FileWarning}
                label="待修复导入"
              />
            </div>
          </div>
        </WorkspacePanel>
      </section>

      <section aria-labelledby="operations-trend-title" className="space-y-3">
        <SectionHeading description="成交趋势与实际出库排行使用同一 7 日窗口。" id="operations-trend-title" title="近 7 天趋势" />
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(21rem,0.75fr)]">
          <WorkspacePanel className="min-w-0 overflow-hidden">
            <WorkspacePanelHeader description="订单按提交日，排行按正常包裹发货日统计。" title="订单与成交金额" />
            {hasTrend ? (
              <div className="px-2 pb-3 pt-2 sm:px-4">
                <SevenDayTrend series={dashboard.sevenDaySeries} />
              </div>
            ) : (
              <div className="px-5 py-12 text-center" role="status">
                <p className="font-medium text-foreground">暂无趋势数据</p>
                <p className="mt-1 text-sm text-muted-foreground">订单提交后，这里会显示近 7 天的真实走势。</p>
                <Link className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-primary-hover" href="/admin/orders">
                  查看订单记录 <ArrowRight aria-hidden="true" className="ml-1 size-4" />
                </Link>
              </div>
            )}
          </WorkspacePanel>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <WorkspacePanel className="overflow-hidden">
              <WorkspacePanelHeader title="SKU 出库排行" />
              {dashboard.topSkus.length ? (
                <ol className="divide-y divide-border">
                  {dashboard.topSkus.map((row, index) => (
                    <li className="flex items-center gap-3 px-4 py-3 sm:px-5" key={row.skuId}>
                      <span className="w-5 text-xs font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.skuCode}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{row.quantity} 件</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-5 py-8 text-sm text-muted-foreground">近 7 天暂无正常出库。</p>
              )}
            </WorkspacePanel>
            <WorkspacePanel className="overflow-hidden">
              <WorkspacePanelHeader title="店铺销量排行" />
              {dashboard.topStores.length ? (
                <ol className="divide-y divide-border">
                  {dashboard.topStores.map((row, index) => (
                    <li className="flex items-center gap-3 px-4 py-3 sm:px-5" key={row.storeId}>
                      <span className="w-5 text-xs font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.storeName}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{row.orderCount} 单</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-5 py-8 text-sm text-muted-foreground">近 7 天暂无店铺出库。</p>
              )}
            </WorkspacePanel>
          </div>
        </div>
      </section>

      <section aria-labelledby="quick-actions-title" className="space-y-3">
        <SectionHeading description="直达高频处理队列，不展开低频表单。" id="quick-actions-title" title="快捷处理" />
        <WorkspacePanel className="overflow-hidden">
          <nav aria-label="管理员快捷处理" className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
            {quickActions.map((action) => (
              <Link className="group flex min-h-14 items-center gap-3 px-4 text-sm font-medium text-foreground outline-none transition-colors hover:bg-surface focus-visible:bg-surface sm:px-5" href={action.href} key={action.href}>
                <action.icon aria-hidden="true" className="size-4 text-primary" />
                <span className="flex-1">{action.label}</span>
                <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </nav>
        </WorkspacePanel>
      </section>
    </div>
  );
}
