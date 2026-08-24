import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  Clock3,
  PackageSearch,
  ReceiptText,
  Store,
  Upload,
  WalletCards,
} from "lucide-react";
import Link from "next/link";

import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import type { CustomerTaskDashboard as CustomerDashboardData } from "@/modules/dashboard/customer-queries";

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

function TaskLink({
  count,
  description,
  href,
  icon: Icon,
  label,
  tone = "default",
}: {
  count: number;
  description: string;
  href: string;
  icon: typeof Clock3;
  label: string;
  tone?: "danger" | "default" | "warning";
}) {
  const iconTone = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-primary";
  return (
    <Link
      className="group flex min-h-[4.5rem] items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-surface focus-visible:bg-surface sm:px-5"
      href={href}
    >
      <Icon aria-hidden="true" className={`size-4 shrink-0 ${iconTone}`} />
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-medium text-foreground">{label}</strong>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <span className="tabular-nums text-lg font-semibold text-foreground">{count}</span>
      <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

const continuationCopy: Record<
  NonNullable<CustomerDashboardData["primaryContinuationTarget"]>["kind"],
  { description: string; label: string }
> = {
  BULK_DRAFT: {
    description: "继续完成多个店铺的订单上传。",
    label: "继续未完成的上传",
  },
  FULFILLMENT_EXCEPTION: {
    description: "有订单需要确认处理方式。",
    label: "查看需要协助的订单",
  },
  PAYMENT_REPORTED: {
    description: "付款资料已提交，正在等待运营确认。",
    label: "查看付款确认进度",
  },
  PENDING_PAYMENT: {
    description: "完成付款后，订单才会进入仓库处理。",
    label: "完成待付款订单",
  },
};

export function CustomerTaskDashboard({
  dashboard,
}: {
  dashboard: CustomerDashboardData;
}) {
  const quickPurchase = [
    { description: "浏览自己的价格和实时可售库存", href: "/portal/catalog", icon: PackageSearch, label: "实时货盘" },
    { description: "上传一个店铺的 TEMU 原始订单", href: "/portal/imports/new", icon: Upload, label: "上传订单" },
  ];
  const continuation = dashboard.primaryContinuationTarget
    ? continuationCopy[dashboard.primaryContinuationTarget.kind]
    : null;

  return (
    <div className="space-y-7">
      <section aria-labelledby="continuation-title" className="space-y-3">
        <SectionHeading description="优先处理会影响付款或发货的事项。" id="continuation-title" title="继续处理" />
        <WorkspacePanel className="overflow-hidden">
          {dashboard.primaryContinuationTarget && continuation ? (
            <div className="flex flex-col gap-4 border-b border-primary/15 bg-primary-soft px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0">
                <p className="font-semibold text-primary-hover">{continuation.label}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{continuation.description}</p>
              </div>
              <Link aria-label={`${continuation.label}，继续处理`} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-white outline-none transition-colors hover:bg-primary-hover" href={dashboard.primaryContinuationTarget.href}>
                继续处理 <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          ) : (
            <div className="border-b border-border px-4 py-5 sm:px-5" role="status">
              <p className="font-medium text-foreground">当前没有未完成任务</p>
              <p className="mt-1 text-sm text-muted-foreground">可以先查看实时货盘，再上传新的订单。</p>
            </div>
          )}
          <div className="divide-y divide-border md:grid md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="divide-y divide-border">
              <TaskLink count={dashboard.unfinishedDraftCount} description="多个店铺尚未完成的上传记录" href="/portal/bulk-orders" icon={Clock3} label="未完成上传" />
              <TaskLink count={dashboard.pendingPaymentCount} description={`${money.format(dashboard.pendingPaymentFen / 100)} 等待付款`} href="/portal/orders?status=PENDING_PAYMENT" icon={ReceiptText} label="待付款" tone="warning" />
            </div>
            <div className="divide-y divide-border">
              <TaskLink count={dashboard.paymentReportedCount} description="付款已申报，等待管理员确认" href="/portal/orders" icon={Banknote} label="付款待确认" />
              <TaskLink count={dashboard.fulfillmentExceptionCount} description="需要确认订单进度或联系运营" href="/portal/orders?status=FULFILLMENT_EXCEPTION" icon={AlertTriangle} label="需要协助" tone="danger" />
            </div>
          </div>
        </WorkspacePanel>
      </section>

      <section aria-labelledby="quick-purchase-title" className="space-y-3">
        <SectionHeading description="查看库存，或上传新的 TEMU 订单。" id="quick-purchase-title" title="快捷拿货" />
        <WorkspacePanel className="overflow-hidden">
          <nav aria-label="快捷拿货" className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
            {quickPurchase.map((item) => (
              <Link className="group flex min-h-[5.5rem] items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-surface focus-visible:bg-surface sm:px-5" href={item.href} key={item.href}>
                <item.icon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium text-foreground">{item.label}</strong>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span>
                </span>
                <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </nav>
          <div className="flex flex-col gap-2 border-t border-border bg-surface/55 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <span className="text-muted-foreground">多个店铺都有订单文件？</span>
            <Link className="inline-flex min-h-11 items-center gap-2 font-medium text-primary-hover" href="/portal/bulk-orders">
              使用多店铺批量上传 <Store aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </WorkspacePanel>
      </section>

      <section aria-labelledby="store-summary-title" className="space-y-3">
        <SectionHeading description={`当前 ${dashboard.activeStoreCount} 家启用店铺，按近 30 天订单量排序。`} id="store-summary-title" title="店铺摘要" />
        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader description="待付款金额不含已申报付款的订单。" title="近期订单与异常" />
          {dashboard.recentStoreSummaries.length ? (
            <div className="divide-y divide-border">
              {dashboard.recentStoreSummaries.map((store) => (
                <article className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-5" key={store.storeId}>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-foreground">{store.storeName}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">近 30 天 {store.recentOrderCount} 单</p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    待付款 <strong className="ml-1 font-medium tabular-nums text-foreground">{store.pendingPaymentCount} 单 · {money.format(store.pendingPaymentFen / 100)}</strong>
                  </p>
                  <p className={store.fulfillmentExceptionCount ? "text-sm text-danger" : "text-sm text-muted-foreground"}>
                    异常 <strong className="ml-1 font-medium tabular-nums">{store.fulfillmentExceptionCount}</strong>
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10" role="status">
              <p className="font-medium text-foreground">还没有启用店铺</p>
              <p className="mt-1 text-sm text-muted-foreground">请联系运营人员开通店铺后再开始拿货。</p>
            </div>
          )}
        </WorkspacePanel>
      </section>

      <section aria-labelledby="funds-summary-title" className="space-y-3">
        <SectionHeading description="查看账户余额与订单占用，不含其他客户资金。" id="funds-summary-title" title="资金摘要" />
        <WorkspacePanel className="overflow-hidden">
          <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { icon: WalletCards, label: "可用余额", value: dashboard.walletAvailableFen },
              { icon: Banknote, label: "账户余额", value: dashboard.walletBalanceFen },
              { icon: Boxes, label: "订单占用", value: dashboard.walletHoldFen },
            ].map((item) => (
              <div className="flex items-center gap-3 px-4 py-4 sm:px-5" key={item.label}>
                <item.icon aria-hidden="true" className="size-4 text-primary" />
                <div>
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{money.format(item.value / 100)}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border px-4 py-2.5 text-right sm:px-5">
            <Link className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-hover" href="/portal/wallet">
              进入资金中心 <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </WorkspacePanel>
      </section>
    </div>
  );
}
