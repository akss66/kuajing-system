import { Activity, Boxes, CircleAlert, PackageX, RefreshCcw, WalletCards } from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getOperationalHealth } from "@/modules/system/health";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export default async function SystemHealthPage() {
  const health = await getOperationalHealth();
  const cards = [
    {
      href: "/admin/system/integrations",
      icon: CircleAlert,
      impact: "订单推送或异常通知可能延迟",
      label: "失败集成任务",
      next: "查看失败任务",
      value: health.checks.failedIntegrations,
    },
    {
      href: "/admin/system/integrations",
      icon: RefreshCcw,
      impact: "后台同步可能停滞，需要核对任务锁定状态",
      label: "超时处理中任务",
      next: "检查同步队列",
      value: health.checks.staleProcessingIntegrations,
    },
    {
      href: "/admin/inventory",
      icon: Boxes,
      impact: "部分 SKU 的可售数量可能不准确",
      label: "库存预占不一致",
      next: "核对货盘库存",
      value: health.checks.overReservedSkus,
    },
    {
      href: "/admin/settlement",
      icon: WalletCards,
      impact: "客户余额与最后一笔流水可能不一致",
      label: "钱包流水不一致",
      next: "核对资金流水",
      value: health.checks.walletMismatches,
    },
    {
      href: "/admin/orders",
      icon: PackageX,
      impact: "客户可能无法看到完整物流进度",
      label: "已发货但无运单",
      next: "查看发货订单",
      value: health.checks.shippedWithoutTracking,
    },
  ];

  const checkedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date(health.checkedAt));

  const totalIssues = cards.reduce((sum, card) => sum + card.value, 0);

  return (
    <div className="space-y-6">
      <PageHeading
        action={
          <Badge
            className={
              health.status === "HEALTHY"
                ? "bg-success/10 text-success"
                : "bg-warning/10 text-warning"
            }
            variant="secondary"
          >
            {health.status === "HEALTHY" ? "运行正常" : "需要处理"}
          </Badge>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "系统健康" },
        ]}
        description="只显示可操作的一致性检查结果，不返回客户隐私、收件地址或第三方凭证。"
        title="系统健康"
      />

      {totalIssues === 0 ? (
        <ActionableEmptyState
          action={<Button asChild size="sm" variant="outline"><Link href="/admin/system/audit">查看审计日志</Link></Button>}
          description="外部任务、库存预占、钱包流水和发货运单检查均未发现异常。"
          kind="initial"
          title="所有运营检查正常"
        />
      ) : null}

      <section aria-labelledby="health-impact-title" className="space-y-3">
        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground" id="health-impact-title">运营影响与下一步</h2>
            <p className="mt-1 text-sm text-muted-foreground">技术检查转为业务影响；这里只提供只读结果和处理路径。</p>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">最近检查：{checkedAt}（多伦多）</p>
        </div>
        <ul className="divide-y divide-border border-b border-border">
          {cards.map((card) => (
            <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={card.label}>
              <div className="flex min-w-0 gap-3">
                <card.icon aria-hidden="true" className={card.value > 0 ? "mt-0.5 size-5 shrink-0 text-warning" : "mt-0.5 size-5 shrink-0 text-success"} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-foreground">{card.label}</h3>
                    <Badge className={card.value > 0 ? "bg-warning/10 text-warning" : "bg-success/10 text-success"} variant="secondary">{card.value > 0 ? `发现 ${card.value} 项` : "检查正常"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{card.impact}</p>
                </div>
              </div>
              <Link className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-hover underline-offset-4 hover:underline" href={card.href}>{card.next}</Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-border pt-5" aria-labelledby="health-readonly-title">
        <div className="flex items-start gap-3">
          <Activity aria-hidden="true" className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="font-semibold text-ink" id="health-readonly-title">只读运营检查说明</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              失败或超时任务需要到外部集成页面查看安全错误摘要；库存与余额不一致时应先停止人工调整，再核对审计记录。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
