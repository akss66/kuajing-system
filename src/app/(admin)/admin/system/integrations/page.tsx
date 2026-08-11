import { desc, eq } from "drizzle-orm";
import { CheckCircle2, CircleDashed, ExternalLink, PlugZap, RefreshCcw } from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db/client";
import { integrationOutbox } from "@/db/schema";
import {
  manualFeishuCargoSyncAction,
  testFeishuConnectionAction,
} from "@/modules/feishu/actions";

function configured(names: string[]) {
  return names.every((name) => Boolean(process.env[name]));
}

export default async function IntegrationsPage() {
  const jifengConfigured = configured([
    "JIFENG_ACCESS_TOKEN", "JIFENG_BASE_URL", "JIFENG_CLIENT_ID",
    "JIFENG_CLIENT_SECRET", "JIFENG_LOGISTICS_ID", "JIFENG_USER_ID",
    "JIFENG_WAREHOUSE_CODE",
  ]);
  const feishuConfigured = configured([
    "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CARGO_WIKI_TOKEN",
    "FEISHU_INTERNAL_CHAT_ID",
  ]);
  const recent = await db
    .select({
      eventType: integrationOutbox.eventType,
      lastErrorCode: integrationOutbox.lastErrorCode,
      status: integrationOutbox.status,
      target: integrationOutbox.target,
      updatedAt: integrationOutbox.updatedAt,
    })
    .from(integrationOutbox)
    .where(eq(integrationOutbox.status, "FAILED"))
    .orderBy(desc(integrationOutbox.updatedAt))
    .limit(10);

  return <div className="space-y-6">
    <header><p className="text-sm font-medium text-primary">系统设置</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">外部集成</h1><p className="mt-2 text-sm text-muted">只显示配置状态和脱敏错误，不会回显任何密钥或令牌。</p></header>
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-[var(--radius-surface)] border border-border bg-background p-5"><div className="flex items-start justify-between gap-4"><div className="flex gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><PlugZap /></div><div><h2 className="font-semibold text-ink">极风 WMS</h2><p className="mt-1 text-sm text-muted">自动推单、加拿大邮政运单和发货状态</p></div></div><Badge className={jifengConfigured ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">{jifengConfigured ? "已配置" : "未配置"}</Badge></div><div className="mt-5 flex items-center gap-2 text-sm text-muted">{jifengConfigured ? <CheckCircle2 className="size-4 text-success" /> : <CircleDashed className="size-4" />}{jifengConfigured ? "凭证字段完整，真实订单将由后台任务联调。" : "需配置仓库域名、授权凭证、仓库和加拿大邮政渠道。"}</div><Link className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary" href="https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce" target="_blank">查看极风接口文档 <ExternalLink className="size-3.5" /></Link></section>
      <section className="rounded-[var(--radius-surface)] border border-border bg-background p-5"><div className="flex items-start justify-between gap-4"><div className="flex gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><RefreshCcw /></div><div><h2 className="font-semibold text-ink">飞书货盘与机器人</h2><p className="mt-1 text-sm text-muted">数据库货盘镜像、异常和库存预警</p></div></div><Badge className={feishuConfigured ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">{feishuConfigured ? "已配置" : "未配置"}</Badge></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><ActionForm action={testFeishuConnectionAction} className="space-y-2" submitLabel="测试飞书连接"><p className="text-xs text-muted">验证应用、知识库和工作表访问权限。</p></ActionForm><ActionForm action={manualFeishuCargoSyncAction} className="space-y-2" submitLabel="重新同步货盘"><p className="text-xs text-muted">手动加入一次全量覆盖任务。</p></ActionForm></div></section>
    </div>
    <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"><div className="border-b border-border px-5 py-4"><h2 className="font-semibold text-ink">最近失败任务</h2><p className="mt-1 text-sm text-muted">错误信息已脱敏，可通过订单详情或任务重试处理。</p></div><div className="divide-y divide-border">{recent.length ? recent.map((item, index) => <div className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[0.8fr_1.2fr_0.8fr_1fr]" key={`${item.eventType}-${index}`}><span className="font-medium text-ink">{item.target}</span><span>{item.eventType}</span><Badge className="w-fit bg-danger/10 text-danger" variant="secondary">{item.status}</Badge><span className="text-muted">{item.lastErrorCode ?? "未知错误"}</span></div>) : <div className="p-8 text-center text-sm text-muted">暂无失败的外部集成任务。</div>}</div></section>
  </div>;
}
