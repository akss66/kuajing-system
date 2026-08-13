import { desc, eq } from "drizzle-orm";
import { CheckCircle2, CircleDashed, ExternalLink, PlugZap, RefreshCcw } from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/forms/action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { integrationOutbox } from "@/db/schema";
import {
  manualFeishuCargoSyncAction,
  testFeishuConnectionAction,
} from "@/modules/feishu/actions";

function configured(names: string[]) {
  return names.every((name) => Boolean(process.env[name]));
}

function integrationTargetLabel(target: "JIFENG" | "FEISHU_SHEET" | "FEISHU_BOT") {
  if (target === "JIFENG") return "极风仓储";
  if (target === "FEISHU_SHEET") return "飞书货盘";
  return "飞书机器人";
}

function integrationEventLabel(eventType: string) {
  if (eventType === "JIFENG_CREATE_ORDER") return "订单推送";
  if (eventType === "FEISHU_CARGO_SYNC") return "货盘同步";
  if (eventType === "FEISHU_NOTIFICATION") return "异常通知";
  return "后台同步任务";
}

function safeErrorLabel(errorCode: string | null) {
  if (errorCode === "REMOTE_TIMEOUT") return "第三方响应超时";
  if (errorCode === "AUTH_FAILED") return "授权校验失败";
  return "任务执行未完成，请按原业务路径重试";
}

export default async function IntegrationsPage() {
  const jifengConfigured = configured([
    "JIFENG_ACCESS_TOKEN",
    "JIFENG_BASE_URL",
    "JIFENG_CLIENT_ID",
    "JIFENG_CLIENT_SECRET",
    "JIFENG_LOGISTICS_ID",
    "JIFENG_USER_ID",
    "JIFENG_WAREHOUSE_CODE",
  ]);
  const feishuConfigured = configured([
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CARGO_WIKI_TOKEN",
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
  const jifengDegraded = recent.some((item) => item.target === "JIFENG");
  const feishuDegraded = recent.some((item) => item.target !== "JIFENG");
  const integrationStatus = (isConfigured: boolean, degraded: boolean) =>
    degraded ? "运行降级" : isConfigured ? "已配置" : "未配置";
  const integrationStatusClass = (isConfigured: boolean, degraded: boolean) =>
    degraded
      ? "bg-danger/10 text-danger"
      : isConfigured
        ? "bg-success/10 text-success"
        : "bg-warning/10 text-warning";

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/system/health", label: "系统健康" },
          { label: "外部集成" },
        ]}
        description="只显示配置状态和脱敏错误摘要，不会回显任何密钥、令牌或第三方账号凭证。"
        title="外部集成"
      />

      <section aria-labelledby="integration-status-title" className="space-y-4">
        <div className="border-b border-border pb-3">
          <h2 className="text-base font-semibold text-foreground" id="integration-status-title">集成运行状态</h2>
          <p className="mt-1 text-sm text-muted-foreground">配置完整性与最近任务结果分开表达，不回显密钥或授权内容。</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
        <article className="border-b border-border pb-5 lg:border lg:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <PlugZap />
              </div>
              <div>
                <h2 className="font-semibold text-ink">极风 WMS</h2>
                <p className="mt-1 text-sm text-muted">
                  用于自动推单、加拿大邮政运单和发货状态同步。
                </p>
              </div>
            </div>
            <Badge
              className={integrationStatusClass(jifengConfigured, jifengDegraded)}
              variant="secondary"
            >
              {integrationStatus(jifengConfigured, jifengDegraded)}
            </Badge>
          </div>
          <div className="mt-5 flex items-center gap-2 text-sm text-muted">
            {jifengConfigured ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <CircleDashed className="size-4" />
            )}
            <span>
              {jifengConfigured
                ? "凭证字段完整，真实订单会由后台任务联调。"
                : "仍需配置仓库域名、授权凭证、仓库编码与物流渠道。"}
            </span>
          </div>
          <Link
            className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary-hover underline-offset-4 hover:underline"
            href="https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce"
            target="_blank"
          >
            查看极风接口文档
            <ExternalLink className="size-3.5" />
          </Link>
        </article>

        <article className="border-b border-border pb-5 lg:border lg:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <RefreshCcw />
              </div>
              <div>
                <h2 className="font-semibold text-ink">飞书货盘与机器人</h2>
                <p className="mt-1 text-sm text-muted">
                  用于货盘镜像、异常通知与库存预警。
                </p>
              </div>
            </div>
            <Badge
              className={integrationStatusClass(feishuConfigured, feishuDegraded)}
              variant="secondary"
            >
              {integrationStatus(feishuConfigured, feishuDegraded)}
            </Badge>
          </div>
          <div className="mt-5">
            <EntityDrawer
              description="测试连接或重新加入货盘同步任务；操作结果沿用现有审计与后台队列。"
              title="管理飞书集成"
              trigger={<Button size="sm" variant="outline">管理飞书</Button>}
            >
              <div className="grid gap-5">
                <ActionForm action={testFeishuConnectionAction} className="space-y-2" submitLabel="测试飞书连接">
                  <p className="text-sm text-muted">验证应用、知识库与工作表访问权限。</p>
                </ActionForm>
                <ActionForm action={manualFeishuCargoSyncAction} className="space-y-2" submitLabel="重新同步货盘">
                  <p className="text-sm text-muted">手动加入一次全量覆盖任务。</p>
                </ActionForm>
              </div>
            </EntityDrawer>
          </div>
        </article>
        </div>
      </section>

      <section aria-labelledby="failed-integration-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div><h2 className="text-base font-semibold text-foreground" id="failed-integration-title">最近失败任务</h2><p className="mt-1 text-sm text-muted-foreground">错误已转为安全运营摘要；请进入原订单或同步路径继续处理。</p></div>
          <span className="text-sm tabular-nums text-muted-foreground">{recent.length} 项</span>
        </div>
          {recent.length ? (
            <ul className="divide-y divide-border border-b border-border">{recent.map((item, index) => (
              <li
                className="grid gap-2 py-4 text-sm sm:grid-cols-[0.9fr_1.2fr_auto_1.4fr] sm:items-center"
                key={`${item.eventType}-${index}`}
              >
                <span className="font-medium text-ink">{integrationTargetLabel(item.target)}</span>
                <span>{integrationEventLabel(item.eventType)}</span>
                <Badge className="w-fit bg-danger/10 text-danger" variant="secondary">
                  执行失败
                </Badge>
                <span className="text-muted">{safeErrorLabel(item.lastErrorCode)}</span>
              </li>
            ))}</ul>
          ) : (
            <ActionableEmptyState
              action={<Button asChild size="sm" variant="outline"><Link href="/admin/system/health">查看系统健康</Link></Button>}
              description="最近没有失败的极风或飞书后台任务。可查看系统健康确认其他一致性检查。"
              kind="initial"
              title="当前没有失败任务"
            />
          )}
      </section>
    </div>
  );
}
