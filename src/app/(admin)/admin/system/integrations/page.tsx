import { desc, eq } from "drizzle-orm";
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  PlugZap,
  RefreshCcw,
} from "lucide-react";
import Link from "next/link";

import { CargoMigrationPanel } from "@/components/feishu/cargo-migration-panel";
import { JifengConnectionCard } from "@/components/integrations/jifeng-connection-card";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { integrationOutbox } from "@/db/schema";
import { FeishuClient } from "@/integrations/feishu/client";
import {
  canImportFeishuCargo,
  canMirrorFeishuCatalog,
  canWriteFeishuCargo,
  hasFeishuCargoTargetConfig,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";
import { inspectJifengConfiguration } from "@/integrations/jifeng/config";
import {
  confirmCargoMigrationAction,
  createCargoPreflightAction,
  retryFeishuCargoSyncAction,
  syncFeishuCatalogFieldsAction,
  testFeishuConnectionAction,
} from "@/modules/feishu/actions";
import {
  findLatestImportedCargoRefreshBaseline,
  getLatestCatalogMirrorTaskState,
  getLatestCatalogFieldRefreshState,
  getLatestCargoMigrationRun,
  getLatestCargoTargetSyncState,
} from "@/modules/feishu/queries";
import { discoverFeishuSourceSheets } from "@/modules/feishu/source-reader";
import { requireAdmin } from "@/modules/identity/guards";
import {
  getJifengConnectionAdminView,
  getJifengConnectionPublicStatus,
  type JifengConnectionAdminView,
} from "@/modules/jifeng-connection/queries";

function configured(names: string[]) {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

function maskIdentifier(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length <= 4) return "****";
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
}

function integrationTargetLabel(target: "JIFENG" | "FEISHU_SHEET" | "FEISHU_BOT") {
  if (target === "JIFENG") return "极风仓储";
  if (target === "FEISHU_SHEET") return "飞书货盘";
  return "飞书机器人";
}

function integrationEventLabel(eventType: string) {
  if (eventType === "JIFENG_CREATE_ORDER") return "已有订单匹配";
  if (eventType === "FEISHU_CARGO_SYNC") return "货盘同步";
  if (eventType === "FEISHU_NOTIFICATION") return "异常通知";
  return "后台同步任务";
}

function safeErrorLabel(errorCode: string | null) {
  if (errorCode === "REMOTE_TIMEOUT") return "第三方响应超时";
  if (errorCode === "AUTH_FAILED") return "授权校验失败";
  return "任务未完成，请按原业务路径重试";
}

async function loadSourceSheetDiscovery(
  principalKind: "ADMIN" | "SUPER_ADMIN",
  feishuConfigured: boolean,
  hasImportedCargoBaseline: boolean,
) {
  if (
    principalKind !== "SUPER_ADMIN" ||
    !feishuConfigured ||
    hasImportedCargoBaseline
  ) {
    return {
      message: null,
      status: "idle" as const,
      sourceSheetOptions: [],
    };
  }

  const config = readFeishuConfig();
  const client = new FeishuClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: readFeishuApiBaseUrl(),
  });
  const discovery = await discoverFeishuSourceSheets({
    client,
    config: { sourceWikiToken: config.sourceWikiToken },
  });

  return {
    message: discovery.status === "ERROR" ? discovery.message : null,
    status: discovery.status === "ERROR" ? ("error" as const) : ("ready" as const),
    sourceSheetOptions: discovery.sheetOptions,
  };
}

export default async function IntegrationsPage() {
  const principal = await requireAdmin();
  const canManageJifeng = principal.kind === "SUPER_ADMIN";
  const feishuConfigured = configured([
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CARGO_SOURCE_WIKI_TOKEN",
  ]);
  const feishuConfig = feishuConfigured ? readFeishuConfig() : null;
  const jifengConfiguration = inspectJifengConfiguration();
  const catalogRefreshBaselinePromise = canManageJifeng
    ? findLatestImportedCargoRefreshBaseline()
    : Promise.resolve(null);

  const [
    connection,
    recent,
    latestMigrationRun,
    sourceSheetDiscovery,
    targetSyncState,
    catalogRefreshBaseline,
    catalogRefreshState,
    catalogMirrorTaskState,
  ] =
    await Promise.all([
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
      getLatestCargoMigrationRun(),
      catalogRefreshBaselinePromise.then((baseline) =>
        loadSourceSheetDiscovery(
          principal.kind,
          feishuConfigured,
          Boolean(baseline),
        ),
      ),
      getLatestCargoTargetSyncState(feishuConfig?.targetSheetId ?? null),
      catalogRefreshBaselinePromise,
      canManageJifeng
        ? getLatestCatalogFieldRefreshState()
        : Promise.resolve({ lastUpdatedLabel: null }),
      canManageJifeng
        ? getLatestCatalogMirrorTaskState()
        : Promise.resolve({
            isActive: false,
            lastUpdatedLabel: null,
            result: null,
            safeErrorMessage: null,
            statusLabel: "尚未执行",
            tone: "default" as const,
          }),
    ]);

  const cargoWritesEnabled = feishuConfig ? canWriteFeishuCargo(feishuConfig) : false;
  const cargoImportEnabled = feishuConfig ? canImportFeishuCargo(feishuConfig) : false;
  const catalogMirrorEnabled = feishuConfig
    ? canMirrorFeishuCatalog(feishuConfig)
    : false;
  const targetConfigured = feishuConfig
    ? hasFeishuCargoTargetConfig(feishuConfig)
    : false;
  const adminConnection = canManageJifeng
    ? (connection as JifengConnectionAdminView)
    : null;
  const jifengConfigured = jifengConfiguration.developer.configured;
  const integrationStatus = (isConfigured: boolean) =>
    isConfigured ? "已配置" : "未配置";
  const integrationStatusClass = (isConfigured: boolean) =>
    isConfigured
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
        description="仅展示配置状态和脱敏错误摘要，不回显任何密钥、令牌或第三方账户凭据。"
        title="外部集成"
      />

      <section aria-labelledby="integration-status-title" className="space-y-4">
        <div className="border-b border-border pb-3">
          <h2
            className="text-base font-semibold text-foreground"
            id="integration-status-title"
          >
            集成运行状态
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            配置完整性与最近任务结果分开展示，不回显密钥或授权内容。
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <article className="border-b border-border pb-5 lg:border lg:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <PlugZap aria-hidden="true" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink">极风 WMS</h3>
                  <p className="mt-1 text-sm text-muted">
                    用于匹配极风已有订单、同步加拿大邮政运单和发货状态。
                  </p>
                </div>
              </div>
              <Badge
                className={integrationStatusClass(jifengConfigured)}
                variant="secondary"
              >
                {integrationStatus(jifengConfigured)}
              </Badge>
            </div>
            <div className="mt-5 flex items-center gap-2 text-sm text-muted">
              {jifengConfigured ? (
                <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
              ) : (
                <CircleDashed aria-hidden="true" className="size-4" />
              )}
              <span>
                {jifengConfigured
                  ? "开发者配置已就绪；实际授权与履约状态见下方连接卡。"
                  : "仍需配置开发者凭证，之后由超级管理员完成官方授权。"}
              </span>
            </div>
            <Link
              className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary-hover underline-offset-4 hover:underline"
              href="https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce"
              rel="noreferrer"
              target="_blank"
            >
              查看极风接口文档
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </Link>
          </article>

          <article className="border-b border-border pb-5 lg:border lg:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <RefreshCcw aria-hidden="true" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink">飞书货盘与机器人</h3>
                  <p className="mt-1 text-sm text-muted">
                    源 wiki 只用于只读预检；数据库导入和派生同步分开控制。
                  </p>
                </div>
              </div>
              <Badge
                className={integrationStatusClass(feishuConfigured)}
                variant="secondary"
              >
                {integrationStatus(feishuConfigured)}
              </Badge>
            </div>
            <div className="mt-5">
              <EntityDrawer
                description="连接验证只做只读校验；目标测试表重试与首批迁移确认分离执行。"
                size="lg"
                title="管理飞书集成"
                trigger={
                  <Button size="sm" variant="outline">
                    管理飞书
                  </Button>
                }
              >
                <CargoMigrationPanel
                  actorKind={principal.kind}
                  cargoImportEnabled={cargoImportEnabled}
                  catalogMirrorEnabled={catalogMirrorEnabled}
                  catalogMirrorTaskState={catalogMirrorTaskState}
                  cargoWritesEnabled={cargoWritesEnabled}
                  confirmCargoMigrationAction={confirmCargoMigrationAction}
                  createCargoPreflightAction={createCargoPreflightAction}
                  importedCargoBaseline={
                    catalogRefreshBaseline
                      ? {
                          importedAtLabel:
                            catalogRefreshBaseline.importedAtLabel,
                          updatedAtLabel:
                            catalogRefreshBaseline.updatedAtLabel,
                        }
                      : null
                  }
                  latestMigrationRun={latestMigrationRun}
                  latestCatalogRefreshLabel={catalogRefreshState.lastUpdatedLabel}
                  readOnlyConnectionMessage="源货盘连接验证全程只读，系统不会向原业务表写入。"
                  retryFeishuCargoSyncAction={retryFeishuCargoSyncAction}
                  selectedSourceSheetId={feishuConfig?.sourceSheetId ?? null}
                  sourceConfigured={feishuConfigured}
                  sourceSheetDiscoveryMessage={sourceSheetDiscovery.message}
                  sourceSheetDiscoveryStatus={sourceSheetDiscovery.status}
                  sourceSheetOptions={sourceSheetDiscovery.sourceSheetOptions}
                  syncFeishuCatalogFieldsAction={syncFeishuCatalogFieldsAction}
                  targetConfigured={targetConfigured}
                  targetSyncState={targetSyncState}
                  testFeishuConnectionAction={testFeishuConnectionAction}
                />
              </EntityDrawer>
            </div>
          </article>
        </div>
      </section>

      <JifengConnectionCard
        canManage={canManageJifeng}
        connection={connection}
        details={
          adminConnection
            ? {
                authorizedAt: adminConnection.authorizedAt,
                developerIdMasked: maskIdentifier(process.env.JIFENG_CLIENT_ID),
                lastError: adminConnection.lastError,
                lastRefreshedAt: adminConnection.lastRefreshedAt,
                logistics: adminConnection.logistics,
                userIdMasked: adminConnection.userIdMasked,
                warehouse: adminConnection.warehouse,
              }
            : undefined
        }
      />

      <section aria-labelledby="failed-integration-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div>
            <h2
              className="text-base font-semibold text-foreground"
              id="failed-integration-title"
            >
              最近失败任务
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              错误已转为安全运营摘要；请进入原订单或同步路径继续处理。
            </p>
          </div>
          <span className="text-sm tabular-nums text-muted-foreground">
            {recent.length} 项
          </span>
        </div>
        {recent.length ? (
          <ul className="divide-y divide-border border-b border-border">
            {recent.map((item, index) => (
              <li
                className="grid gap-2 py-4 text-sm sm:grid-cols-[0.9fr_1.2fr_auto_1.4fr] sm:items-center"
                key={`${item.eventType}-${index}`}
              >
                <span className="font-medium text-ink">
                  {integrationTargetLabel(item.target)}
                </span>
                <span>{integrationEventLabel(item.eventType)}</span>
                <Badge className="w-fit bg-danger/10 text-danger" variant="secondary">
                  执行失败
                </Badge>
                <span className="text-muted">{safeErrorLabel(item.lastErrorCode)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ActionableEmptyState
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/system/health">查看系统健康</Link>
              </Button>
            }
            description="最近没有失败的极风或飞书后台任务。可查看系统健康确认其他一致性检查。"
            kind="initial"
            title="当前没有失败任务"
          />
        )}
      </section>
    </div>
  );
}
