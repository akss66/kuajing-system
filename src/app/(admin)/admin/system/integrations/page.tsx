import { desc, eq } from "drizzle-orm";
import { ExternalLink, RefreshCcw } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ActionForm } from "@/components/forms/action-form";
import { JifengConnectionCard } from "@/components/integrations/jifeng-connection-card";
import { PageHeading } from "@/components/layout/page-heading";
import {
  WorkspacePanel,
  WorkspacePanelHeader,
} from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db/client";
import { integrationOutbox } from "@/db/schema";
import { inspectJifengConfiguration } from "@/integrations/jifeng/config";
import {
  manualFeishuCargoSyncAction,
  testFeishuConnectionAction,
} from "@/modules/feishu/actions";
import { requireAdmin } from "@/modules/identity/guards";
import {
  getJifengConnectionAdminView,
  getJifengConnectionPublicStatus,
} from "@/modules/jifeng-connection/queries";
import type { JifengConnectionStatus } from "@/modules/jifeng-connection/types";

function configured(names: string[]) {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

function maskIdentifier(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length <= 4) return "****";
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
}

const connectionLabels: Record<JifengConnectionStatus, string> = {
  AUTHORIZED: "待发现资源",
  DISCONNECTED: "未连接",
  ENABLED: "自动履约已启用",
  ERROR: "连接异常",
  READY_DISABLED: "已就绪，未启用",
  REFRESH_REQUIRED: "授权待更新",
  RESOURCE_SELECTION_REQUIRED: "待选择资源",
};

export default async function IntegrationsPage() {
  const principal = await requireAdmin();
  const canManageJifeng = principal.kind === "SUPER_ADMIN";
  const [connection, recent] = await Promise.all([
    canManageJifeng
      ? getJifengConnectionAdminView()
      : getJifengConnectionPublicStatus(),
    db
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
      .limit(10),
  ]);
  const jifengConfiguration = inspectJifengConfiguration();
  const feishuConfigured = configured([
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CARGO_WIKI_TOKEN",
    "FEISHU_INTERNAL_CHAT_ID",
  ]);

  return (
    <div className="space-y-6">
      <PageHeading
        action={
          <Link
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary"
            href="https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce"
            rel="noreferrer"
            target="_blank"
          >
            极风接口文档
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </Link>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/system/health", label: "系统健康" },
          { label: "外部集成" },
        ]}
        description="查看脱敏连接状态并管理外部系统。授权凭证、一次性令牌和第三方错误原文不会在页面中显示。"
        title="外部集成"
      />

      <MetricStrip
        items={[
          {
            hint: jifengConfiguration.developer.configured
              ? "开发者配置已就绪"
              : "开发者配置待补齐",
            label: "极风连接",
            tone:
              connection.status === "ENABLED" ||
              connection.status === "READY_DISABLED"
                ? "success"
                : connection.status === "ERROR"
                  ? "danger"
                  : "warning",
            value: connectionLabels[connection.status],
          },
          {
            hint: connection.fulfillmentEnabled
              ? "真实订单会进入自动推送"
              : "不会创建新的自动履约任务",
            label: "极风自动履约",
            tone: connection.fulfillmentEnabled ? "success" : "default",
            value: connection.fulfillmentEnabled ? "已启用" : "已关闭",
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

      {canManageJifeng && "authorizedAt" in connection ? (
        <JifengConnectionCard
          canManage
          connection={connection}
          details={{
            authorizedAt: connection.authorizedAt,
            developerIdMasked: maskIdentifier(process.env.JIFENG_CLIENT_ID),
            lastError: connection.lastError,
            lastRefreshedAt: connection.lastRefreshedAt,
            logistics: connection.logistics,
            userIdMasked: connection.userIdMasked,
            warehouse: connection.warehouse,
          }}
        />
      ) : (
        <JifengConnectionCard canManage={false} connection={connection} />
      )}

      <WorkspacePanel className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-primary-soft text-primary">
              <RefreshCcw aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-ink">飞书货盘与机器人</h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                用于货盘镜像、异常通知与库存预警。
              </p>
            </div>
          </div>
          <Badge
            className={
              feishuConfigured
                ? "bg-success/10 text-success"
                : "bg-warning/10 text-warning"
            }
            variant="secondary"
          >
            {feishuConfigured ? "已配置" : "未配置"}
          </Badge>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <ActionForm
            action={testFeishuConnectionAction}
            className="space-y-2"
            submitLabel="测试飞书连接"
          >
            <p className="text-xs leading-5 text-muted">
              验证应用、知识库与工作表访问权限。
            </p>
          </ActionForm>
          <ActionForm
            action={manualFeishuCargoSyncAction}
            className="space-y-2"
            submitLabel="重新同步货盘"
          >
            <p className="text-xs leading-5 text-muted">
              手动加入一次全量覆盖任务。
            </p>
          </ActionForm>
        </div>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="错误内容已脱敏。需要进一步处理时，请进入对应订单或任务的恢复路径。"
          title="最近失败任务"
        />
        <div className="divide-y divide-border">
          {recent.length ? (
            recent.map((item, index) => (
              <div
                className="grid min-w-0 gap-2 px-4 py-4 text-sm sm:grid-cols-[0.9fr_1.2fr_0.8fr_1fr] sm:px-5"
                key={`${item.eventType}-${index}`}
              >
                <span className="min-w-0 break-words font-medium text-ink">
                  {item.target}
                </span>
                <span className="min-w-0 break-words">{item.eventType}</span>
                <Badge className="w-fit bg-danger/10 text-danger" variant="secondary">
                  {item.status}
                </Badge>
                <span className="text-muted">
                  {item.lastErrorCode ? "已记录安全错误分类" : "错误分类待补充"}
                </span>
              </div>
            ))
          ) : (
            <div className="px-6 py-12 text-center text-sm text-muted">
              暂无失败的外部集成任务。
            </div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
