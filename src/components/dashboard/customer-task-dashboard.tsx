import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  CheckCircle2,
  Clock3,
  PackageSearch,
  ReceiptText,
  Store,
  Upload,
  WalletCards,
} from "lucide-react";
import Link from "next/link";

import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { cn } from "@/lib/utils";
import type { CustomerTaskDashboard as CustomerDashboardData } from "@/modules/dashboard/customer-queries";

const money = new Intl.NumberFormat("zh-CN", { currency: "CNY", style: "currency" });

function SectionHeading({ description, id, title }: { description: string; id: string; title: string }) {
  return (
    <div className="portal-section-heading">
      <h2 className="text-base font-semibold tracking-[-0.015em] text-foreground" id={id}>{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function TaskLink({ count, description, href, icon: Icon, label, tone = "default" }: {
  count: number;
  description: string;
  href: string;
  icon: typeof Clock3;
  label: string;
  tone?: "danger" | "default" | "warning";
}) {
  const inactive = count === 0;
  const iconTone = inactive ? "text-slate-500" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-primary";
  return (
    <Link
      className={cn(
        "group flex min-h-20 items-center gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-[0_2px_12px_rgb(0_0_0/0.02)] outline-none transition-[background-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-white hover:shadow-lg focus-visible:ring-3 focus-visible:ring-primary/20 sm:px-5",
        inactive && "bg-slate-50/60",
      )}
      data-task-tone={tone}
      href={href}
    >
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", inactive ? "bg-slate-50" : "bg-[var(--portal-icon-surface)]")}>
        <Icon aria-hidden="true" className={`size-[18px] ${iconTone}`} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold text-foreground">{label}</strong>
        <span className="mt-0.5 hidden text-xs leading-5 text-slate-600 sm:block">{description}</span>
      </span>
      <span className={cn("tabular-nums text-lg font-semibold tracking-tight", inactive ? "text-slate-500" : "text-foreground")}>{count}</span>
      <ArrowRight aria-hidden="true" className="hidden size-4 text-slate-500 transition-transform group-hover:translate-x-0.5 sm:block" />
    </Link>
  );
}

const continuationCopy: Record<
  NonNullable<CustomerDashboardData["primaryContinuationTarget"]>["kind"],
  { description: string; label: string }
> = {
  BULK_DRAFT: { description: "继续完成多个店铺的订单上传。", label: "继续未完成的上传" },
  FULFILLMENT_EXCEPTION: { description: "有订单需要确认处理方式。", label: "查看需要协助的订单" },
  PAYMENT_REPORTED: { description: "付款资料已提交，正在等待运营确认。", label: "查看付款确认进度" },
  PENDING_PAYMENT: { description: "完成付款后，订单才会进入仓库处理。", label: "完成待付款订单" },
};

export function CustomerTaskDashboard({ dashboard }: { dashboard: CustomerDashboardData }) {
  const continuation = dashboard.primaryContinuationTarget
    ? continuationCopy[dashboard.primaryContinuationTarget.kind]
    : null;
  const taskLinks = [
    {
      count: dashboard.unfinishedDraftCount,
      description: "未完成的多店铺上传",
      href: "/portal/bulk-orders",
      icon: Clock3,
      kind: "BULK_DRAFT",
      label: "未完成上传",
    },
    {
      count: dashboard.pendingPaymentCount,
      description: `${money.format(dashboard.pendingPaymentFen / 100)} 等待付款`,
      href: "/portal/orders?status=PENDING_PAYMENT",
      icon: ReceiptText,
      kind: "PENDING_PAYMENT",
      label: "待付款",
      tone: "warning" as const,
    },
    {
      count: dashboard.paymentReportedCount,
      description: "付款已申报，等待管理员确认",
      href: "/portal/orders",
      icon: Banknote,
      kind: "PAYMENT_REPORTED",
      label: "付款待确认",
    },
    {
      count: dashboard.fulfillmentExceptionCount,
      description: "需要确认进度或联系运营",
      href: "/portal/orders?status=FULFILLMENT_EXCEPTION",
      icon: AlertTriangle,
      kind: "FULFILLMENT_EXCEPTION",
      label: "需要协助",
      tone: "danger" as const,
    },
  ].filter(
    (item) =>
      item.count > 0 && item.kind !== dashboard.primaryContinuationTarget?.kind,
  );

  return (
    <div className="space-y-9" data-portal-dashboard>
      <section aria-labelledby="continuation-title" className="space-y-3" data-portal-continuation>
        <SectionHeading description="把影响付款和发货的事项放在最前面。" id="continuation-title" title="继续处理" />
        <div className="space-y-4">
          {dashboard.primaryContinuationTarget && continuation ? (
            <div className="flex flex-col gap-4 rounded-2xl bg-primary-soft/70 px-4 py-4 shadow-[0_2px_12px_rgb(0_0_0/0.02)] sm:flex-row sm:items-center sm:justify-between" data-portal-focus>
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-primary shadow-sm">
                  <Clock3 aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0">
                  <span className="text-xs font-semibold text-primary-hover">建议先完成</span>
                  <h3 className="mt-1 text-base font-semibold tracking-[-0.015em] text-foreground">{continuation.label}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{continuation.description}</p>
                </div>
              </div>
              <Link
                aria-label={`${continuation.label}，继续处理`}
                className="portal-focus-action inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[0.7rem] bg-primary px-5 text-sm font-semibold text-white outline-none transition-[transform,background-color,box-shadow] hover:bg-primary-hover hover:shadow-md focus-visible:ring-3 focus-visible:ring-primary/25"
                href={dashboard.primaryContinuationTarget.href}
              >
                继续处理 <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          ) : (
            <div
              aria-label="当前拿货均已处理完成"
              className="flex flex-col gap-4 rounded-2xl bg-[var(--portal-ready-surface)] px-4 py-4 shadow-[0_2px_12px_rgb(0_0_0/0.02)] sm:flex-row sm:items-center sm:justify-between"
              data-portal-ready
              role="status"
            >
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="portal-ready-mark flex size-10 shrink-0 items-center justify-center rounded-full bg-success text-white">
                  <CheckCircle2 aria-hidden="true" className="size-5" />
                </span>
                <div>
                  <h3 className="text-base font-semibold tracking-[-0.015em] text-foreground">当前拿货均已处理完成</h3>
                  <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">订单、付款和异常都已处理完成，可以开始新的拿货流程。</p>
                </div>
              </div>
            </div>
          )}

          {taskLinks.length ? (
            <div className="grid gap-3 sm:grid-cols-2" data-portal-task-overview>
              {taskLinks.map((item) => (
                <TaskLink
                  count={item.count}
                  description={item.description}
                  href={item.href}
                  icon={item.icon}
                  key={item.kind}
                  label={item.label}
                  tone={item.tone}
                />
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="quick-purchase-title" className="space-y-3" data-portal-quick-actions>
        <SectionHeading description="先确认货盘，再上传 TEMU 原始订单。" id="quick-purchase-title" title="快捷拿货" />
        <nav aria-label="快捷拿货" className="grid overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)] md:grid-cols-2">
          <Link className="portal-primary-route group flex min-h-28 items-center gap-4 px-5 py-5 outline-none md:border-r md:border-border sm:px-6" href="/portal/catalog">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-[0.8rem] bg-primary text-white"><PackageSearch aria-hidden="true" className="size-5" /></span>
            <span className="min-w-0 flex-1"><strong className="block text-base font-semibold text-foreground">实时货盘</strong><span className="mt-1 block text-sm leading-6 text-muted-foreground">查看你的价格、规格和实时可售库存</span></span>
            <ArrowRight aria-hidden="true" className="size-5 text-primary transition-transform group-hover:translate-x-1" />
          </Link>
          <Link className="portal-primary-route group flex min-h-28 items-center gap-4 border-t border-border px-5 py-5 outline-none md:border-t-0 sm:px-6" href="/portal/imports/new">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-[0.8rem] bg-[var(--portal-accent-surface)] text-[var(--portal-accent-foreground)]"><Upload aria-hidden="true" className="size-5" /></span>
            <span className="min-w-0 flex-1"><strong className="block text-base font-semibold text-foreground">上传订单</strong><span className="mt-1 block text-sm leading-6 text-muted-foreground">上传一个店铺的 TEMU 原始订单</span></span>
            <ArrowRight aria-hidden="true" className="size-5 text-primary transition-transform group-hover:translate-x-1" />
          </Link>
          <div className="flex flex-col gap-2 border-t border-border bg-[var(--portal-subtle-surface)] px-5 py-3 text-sm md:col-span-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span className="text-muted-foreground">多个店铺都有订单文件？</span>
            <Link className="inline-flex min-h-11 items-center gap-2 font-semibold text-primary-hover" href="/portal/bulk-orders">使用多店铺批量上传 <Store aria-hidden="true" className="size-4" /></Link>
          </div>
        </nav>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]" data-portal-summary-grid>
        <section aria-labelledby="store-summary-title" className="space-y-3">
          <SectionHeading description={`当前 ${dashboard.activeStoreCount} 家启用店铺，按近 30 天订单量排序。`} id="store-summary-title" title="店铺摘要" />
          <WorkspacePanel className="overflow-hidden">
            <WorkspacePanelHeader description="待付款金额不含已申报付款的订单。" title="近期订单与异常" />
            {dashboard.recentStoreSummaries.length ? (
              <div className="divide-y divide-border">
                {dashboard.recentStoreSummaries.map((store) => (
                  <article className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-5" key={store.storeId}>
                    <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-foreground">{store.storeName}</h3><p className="mt-1 text-xs text-muted-foreground">近 30 天 {store.recentOrderCount} 单</p></div>
                    <p className="text-sm text-muted-foreground">待付款 <strong className="ml-1 font-semibold tabular-nums text-foreground">{store.pendingPaymentCount} 单 · {money.format(store.pendingPaymentFen / 100)}</strong></p>
                    <p className={store.fulfillmentExceptionCount ? "text-sm text-danger" : "text-sm text-muted-foreground"}>异常 <strong className="ml-1 font-semibold tabular-nums">{store.fulfillmentExceptionCount}</strong></p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="px-5 py-10" role="status"><p className="font-medium text-foreground">还没有启用店铺</p><p className="mt-1 text-sm text-muted-foreground">请联系运营人员开通店铺后再开始拿货。</p></div>
            )}
          </WorkspacePanel>
        </section>

        <section aria-labelledby="funds-summary-title" className="space-y-3">
          <SectionHeading description="账户余额和订单预留。" id="funds-summary-title" title="资金摘要" />
          <WorkspacePanel className="overflow-hidden">
            <div className="divide-y divide-border">
              {[
                { featured: true, icon: WalletCards, label: "可用余额", value: dashboard.walletAvailableFen },
                { icon: Banknote, label: "账户余额", value: dashboard.walletBalanceFen },
                { icon: Boxes, label: "订单预留", value: dashboard.walletHoldFen },
              ].map((item) => (
                <div className={item.featured ? "flex items-center gap-3 bg-primary/5 px-4 py-4 sm:px-5" : "flex items-center gap-3 px-4 py-4 sm:px-5"} key={item.label}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[0.65rem] bg-[var(--portal-icon-surface)] text-primary"><item.icon aria-hidden="true" className="size-4" /></span>
                  <div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{item.label}</p><p className={item.featured ? "mt-1 truncate text-xl font-semibold tabular-nums text-primary-hover" : "mt-1 truncate text-lg font-semibold tabular-nums text-foreground"}>{money.format(item.value / 100)}</p></div>
                </div>
              ))}
            </div>
            <div className="border-t border-border px-4 py-2.5 text-right sm:px-5"><Link className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary-hover" href="/portal/wallet">进入资金中心 <ArrowRight aria-hidden="true" className="size-4" /></Link></div>
          </WorkspacePanel>
        </section>
      </div>
    </div>
  );
}
