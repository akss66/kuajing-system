import { Activity, Boxes, CircleAlert, PackageX, RefreshCcw, WalletCards } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { getOperationalHealth } from "@/modules/system/health";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export default async function SystemHealthPage() {
  const health = await getOperationalHealth();
  const cards = [
    { href: "/admin/system/integrations", icon: CircleAlert, label: "失败集成任务", value: health.checks.failedIntegrations },
    { href: "/admin/system/integrations", icon: RefreshCcw, label: "超时处理中任务", value: health.checks.staleProcessingIntegrations },
    { href: "/admin/inventory", icon: Boxes, label: "库存预占不一致", value: health.checks.overReservedSkus },
    { href: "/admin/settlement", icon: WalletCards, label: "余额流水不一致", value: health.checks.walletMismatches },
    { href: "/admin/orders", icon: PackageX, label: "已发货但无运单", value: health.checks.shippedWithoutTracking },
  ];
  const checkedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date(health.checkedAt));

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-sm font-medium text-primary">只读运营检查</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">系统健康</h1><p className="mt-2 text-sm text-muted">检查数据库内可行动的不一致，不返回客户隐私、收件地址或第三方凭证。</p></div>
        <Badge className={health.status === "HEALTHY" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">{health.status === "HEALTHY" ? "运行正常" : "需要处理"}</Badge>
      </header>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="健康检查项目">
        {cards.map((card) => <Link className="rounded-[var(--radius-surface)] border border-border bg-background p-5 transition-colors hover:border-primary/40" href={card.href} key={card.label}><card.icon aria-hidden="true" className={card.value > 0 ? "size-5 text-warning" : "size-5 text-success"} /><p className="mt-4 text-2xl font-semibold tabular-nums text-ink">{card.value}</p><p className="mt-1 text-sm text-muted">{card.label}</p></Link>)}
      </section>
      <section className="rounded-[var(--radius-surface)] border border-border bg-background p-5"><div className="flex items-start gap-3"><Activity aria-hidden="true" className="mt-0.5 size-5 text-primary" /><div><h2 className="font-semibold text-ink">检查说明</h2><p className="mt-1 text-sm leading-6 text-muted">失败或超时任务需要到外部集成页查看安全错误摘要；库存与余额不一致时停止相关人工调整并核对审计日志。健康页不会自动修复数据，避免掩盖问题。</p><p className="mt-3 text-xs tabular-nums text-muted">最近检查：{checkedAt}（多伦多）</p></div></div></section>
    </div>
  );
}
