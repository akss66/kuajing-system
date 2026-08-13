import { desc, eq } from "drizzle-orm";
import { CheckCircle2, CircleDashed, ExternalLink, PlugZap, RefreshCcw } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ActionForm } from "@/components/forms/action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
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
    "FEISHU_CARGO_SOURCE_WIKI_TOKEN",
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

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/system/health", label: "系统健康" },
          { label: "外部集成" },
        ]}
        description="只显示配置状态和脱敏错误摘要，不会回显任何密钥、令牌或第三方账户凭证。"
        title="外部集成"
      />

      <MetricStrip
        items={[
          {
            label: "极风配置",
            tone: jifengConfigured ? "success" : "warning",
            value: jifengConfigured ? "已就绪" : "待补齐",
          },
          {
            label: "飞书配置",
            tone: feishuConfigured ? "success" : "warning",
            value: feishuConfigured ? "已就绪" : "待补齐",
          },
          {
            label: "失败任务",
            tone: recent.length > 0 ? "warning" : "default",
            value: `${recent.length}`,
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <WorkspacePanel className="p-5">
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
              className={jifengConfigured ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}
              variant="secondary"
            >
              {jifengConfigured ? "已配置" : "未配置"}
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
            className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary"
            href="https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce"
            target="_blank"
          >
            查看极风接口文档
            <ExternalLink className="size-3.5" />
          </Link>
        </WorkspacePanel>

        <WorkspacePanel className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <RefreshCcw />
              </div>
              <div>
                <h2 className="font-semibold text-ink">飞书货盘与机器人</h2>
                <p className="mt-1 text-sm text-muted">
                  源 wiki 只用于预检；目标测试表与机器人通知按需独立启用。
                </p>
              </div>
            </div>
            <Badge
              className={feishuConfigured ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}
              variant="secondary"
            >
              {feishuConfigured ? "已配置" : "未配置"}
            </Badge>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ActionForm
              action={testFeishuConnectionAction}
              className="space-y-2"
              submitLabel="测试飞书连接"
            >
              <p className="text-xs text-muted">
                预检源 wiki 与源电子表格访问权限。
              </p>
            </ActionForm>
            <ActionForm
              action={manualFeishuCargoSyncAction}
              className="space-y-2"
              submitLabel="重新同步货盘"
            >
              <p className="text-xs text-muted">
                仅当目标测试表完整配置后才允许手动写入。
              </p>
            </ActionForm>
          </div>
        </WorkspacePanel>
      </div>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="错误信息已脱敏。需要进一步处理时，请进入订单详情或任务重试路径。"
          title="最近失败任务"
        />
        <div className="divide-y divide-border">
          {recent.length ? (
            recent.map((item, index) => (
              <div
                className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[0.9fr_1.2fr_0.8fr_1fr]"
                key={`${item.eventType}-${index}`}
              >
                <span className="font-medium text-ink">{item.target}</span>
                <span>{item.eventType}</span>
                <Badge className="w-fit bg-danger/10 text-danger" variant="secondary">
                  {item.status}
                </Badge>
                <span className="text-muted">{item.lastErrorCode ?? "未知错误"}</span>
              </div>
            ))
          ) : (
            <div className="px-6 py-16 text-center text-sm text-muted">
              暂无失败的外部集成任务。
            </div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
