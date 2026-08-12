import { Activity, Boxes, CircleAlert, PackageX, RefreshCcw, WalletCards } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { getOperationalHealth } from "@/modules/system/health";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export default async function SystemHealthPage() {
  const health = await getOperationalHealth();
  const cards = [
    {
      href: "/admin/system/integrations",
      icon: CircleAlert,
      label: "失败集成任务",
      value: health.checks.failedIntegrations,
    },
    {
      href: "/admin/system/integrations",
      icon: RefreshCcw,
      label: "超时处理中任务",
      value: health.checks.staleProcessingIntegrations,
    },
    {
      href: "/admin/inventory",
      icon: Boxes,
      label: "库存预占不一致",
      value: health.checks.overReservedSkus,
    },
    {
      href: "/admin/settlement",
      icon: WalletCards,
      label: "钱包流水不一致",
      value: health.checks.walletMismatches,
    },
    {
      href: "/admin/orders",
      icon: PackageX,
      label: "已发货但无运单",
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

      <MetricStrip
        items={[
          {
            label: "总问题数",
            tone: totalIssues > 0 ? "warning" : "default",
            value: `${totalIssues}`,
          },
          { label: "失败集成", value: `${health.checks.failedIntegrations}` },
          { label: "库存异常", value: `${health.checks.overReservedSkus}` },
          { label: "钱包异常", value: `${health.checks.walletMismatches}` },
        ]}
      />

      <section
        aria-label="健康检查项目"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        {cards.map((card) => (
          <Link
            className="rounded-[var(--radius-surface)] border border-border bg-background p-5 transition-colors hover:border-primary/40 hover:bg-surface"
            href={card.href}
            key={card.label}
          >
            <card.icon
              aria-hidden="true"
              className={card.value > 0 ? "size-5 text-warning" : "size-5 text-success"}
            />
            <p className="mt-4 text-2xl font-semibold tabular-nums text-ink">
              {card.value}
            </p>
            <p className="mt-1 text-sm text-muted">{card.label}</p>
          </Link>
        ))}
      </section>

      <WorkspacePanel className="p-5">
        <div className="flex items-start gap-3">
          <Activity aria-hidden="true" className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="font-semibold text-ink">只读运营检查说明</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              失败或超时任务需要到外部集成页面查看安全错误摘要；库存与余额不一致时应先停止人工调整，再核对审计记录。
            </p>
            <p className="mt-3 text-xs tabular-nums text-muted">
              最近检查：{checkedAt}（多伦多）
            </p>
          </div>
        </div>
      </WorkspacePanel>
    </div>
  );
}
