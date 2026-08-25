"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import {
  WorkspacePanel,
  WorkspacePanelHeader,
} from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import type { FeishuCatalogMirrorPhase } from "@/integrations/feishu/config";
import { cn } from "@/lib/utils";
import type { CargoMigrationActionState } from "@/modules/feishu/actions";
import type {
  CargoMigrationPanelRun,
  CatalogMirrorTaskState,
  CargoMigrationTargetSyncState,
} from "@/modules/feishu/queries";
import {
  INITIAL_ACTION_STATE,
  type ActionState,
  type ManagedAction,
} from "@/shared/action-state";

import { CargoPreflightTable } from "./cargo-preflight-table";

type ActorKind = "ADMIN" | "SUPER_ADMIN";

type PreflightManagedAction = (
  previousState: CargoMigrationActionState,
  formData: FormData,
) => Promise<CargoMigrationActionState>;

type SourceSheetOption = {
  index: number;
  sheetId: string;
  title: string;
};

export type CargoMigrationPanelProps = {
  actorKind: ActorKind;
  cargoImportEnabled: boolean;
  catalogMirrorCutoffLabel: string | null;
  catalogMirrorEnabled: boolean;
  catalogMirrorPhase: FeishuCatalogMirrorPhase;
  catalogMirrorTaskState: CatalogMirrorTaskState;
  cargoWritesEnabled: boolean;
  confirmCargoMigrationAction?: ManagedAction;
  createCargoPreflightAction: PreflightManagedAction;
  importedCargoBaseline: {
    importedAtLabel: string | null;
    updatedAtLabel: string;
  } | null;
  latestMigrationRun: CargoMigrationPanelRun | null;
  latestCatalogRefreshLabel: string | null;
  readOnlyConnectionMessage: string;
  retryFeishuCargoSyncAction: ManagedAction;
  selectedSourceSheetId: string | null;
  sourceConfigured: boolean;
  sourceSheetDiscoveryMessage: string | null;
  sourceSheetDiscoveryStatus: "error" | "idle" | "ready";
  sourceSheetOptions: SourceSheetOption[];
  syncFeishuCatalogFieldsAction: ManagedAction;
  targetConfigured: boolean;
  targetSyncState: CargoMigrationTargetSyncState;
  testFeishuConnectionAction: ManagedAction;
};

function badgeToneClass(tone: "danger" | "default" | "success" | "warning") {
  switch (tone) {
    case "danger":
      return "bg-danger/10 text-danger";
    case "success":
      return "bg-success/10 text-success";
    case "warning":
      return "bg-warning/10 text-warning";
    default:
      return "border border-border bg-background text-foreground";
  }
}

function actionStateMessageClass(status: ActionState["status"]) {
  return status === "success"
    ? "border-success/20 bg-success/5 text-success"
    : "border-danger/20 bg-danger/5 text-danger";
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-all text-sm text-foreground">{value}</p>
    </div>
  );
}

export function CargoMigrationPanel({
  actorKind,
  cargoImportEnabled,
  catalogMirrorCutoffLabel,
  catalogMirrorEnabled,
  catalogMirrorPhase,
  catalogMirrorTaskState,
  cargoWritesEnabled,
  confirmCargoMigrationAction,
  createCargoPreflightAction,
  importedCargoBaseline,
  latestMigrationRun,
  latestCatalogRefreshLabel,
  readOnlyConnectionMessage,
  retryFeishuCargoSyncAction,
  selectedSourceSheetId,
  sourceConfigured,
  sourceSheetDiscoveryMessage,
  sourceSheetDiscoveryStatus,
  sourceSheetOptions,
  syncFeishuCatalogFieldsAction,
  targetConfigured,
  targetSyncState,
  testFeishuConnectionAction,
}: CargoMigrationPanelProps) {
  const router = useRouter();
  const [preflightState, preflightFormAction, preflightPending] = useActionState(
    createCargoPreflightAction,
    INITIAL_ACTION_STATE as CargoMigrationActionState,
  );
  const [catalogSyncState, catalogSyncFormAction, catalogSyncPending] =
    useActionState(syncFeishuCatalogFieldsAction, INITIAL_ACTION_STATE);
  const [selectedSheetId, setSelectedSheetId] = useState(() => {
    if (selectedSourceSheetId) return selectedSourceSheetId;
    return sourceSheetOptions.length === 1 ? sourceSheetOptions[0].sheetId : "";
  });
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const refreshedCatalogSyncStateRef = useRef<ActionState | null>(null);

  useEffect(() => {
    if (
      catalogSyncState.status !== "success" ||
      refreshedCatalogSyncStateRef.current === catalogSyncState
    ) {
      return;
    }
    refreshedCatalogSyncStateRef.current = catalogSyncState;
    router.refresh();
  }, [catalogSyncState, router]);

  useEffect(() => {
    if (!catalogMirrorTaskState.isActive) return;
    const timer = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [catalogMirrorTaskState.isActive, router]);

  const availableSourceSheets = useMemo(
    () =>
      preflightState.availableSourceSheets?.length
        ? preflightState.availableSourceSheets
        : sourceSheetOptions,
    [preflightState.availableSourceSheets, sourceSheetOptions],
  );
  const hasMultipleSourceSheets = availableSourceSheets.length > 1;
  const effectiveSelectedSheetId =
    selectedSheetId ||
    selectedSourceSheetId ||
    (availableSourceSheets.length === 1 ? availableSourceSheets[0].sheetId : "");
  const imported = Boolean(importedCargoBaseline);
  const skuCount = latestMigrationRun?.summary.skuCount ?? 0;
  const expectedPhrase = `确认迁移${skuCount}个SKU`;
  const sourceDiscoveryFailed =
    sourceSheetDiscoveryStatus === "error" && !effectiveSelectedSheetId;
  const requiresSourceSelection =
    actorKind === "SUPER_ADMIN" &&
    !selectedSourceSheetId &&
    hasMultipleSourceSheets &&
    !selectedSheetId;
  const canCreatePreflight =
    actorKind === "SUPER_ADMIN" &&
    !imported &&
    sourceConfigured &&
    !sourceDiscoveryFailed &&
    !requiresSourceSelection &&
    Boolean(effectiveSelectedSheetId);
  const canConfirm =
    cargoImportEnabled &&
    actorKind === "SUPER_ADMIN" &&
    latestMigrationRun?.status === "PREFLIGHT_READY" &&
    latestMigrationRun.blockingIssueCount === 0;
  const confirmAction =
    confirmCargoMigrationAction ??
    (async () => INITIAL_ACTION_STATE);
  const syncSubmitLabel = targetSyncState.canRetry
    ? "重试目标同步"
    : "重新同步目标测试表";
  const preflightSubmitLabel = preflightPending
    ? "正在执行只读预检"
    : !sourceConfigured
      ? "源货盘未配置"
      : sourceDiscoveryFailed
        ? "先恢复源工作表读取"
        : requiresSourceSelection
          ? "选择源工作表后开始只读预检"
          : "开始只读预检";
  const showMetricSummary = Boolean(latestMigrationRun);
  const showExpandedSourceFields = Boolean(latestMigrationRun);
  const catalogMirrorSummary =
    catalogMirrorPhase === "TRANSITION"
      ? `飞书源货盘始终只读。当前处于单向镜像过渡期，飞书仍是唯一人工维护源；同步入口将在北京时间 ${catalogMirrorCutoffLabel ?? "配置的截止时间"} 自动关闭，之后系统货盘接管。`
      : catalogMirrorPhase === "RETIRED"
        ? `飞书货盘镜像已于北京时间 ${catalogMirrorCutoffLabel ?? "配置的截止时间"} 停用，系统货盘现已接管；飞书仅保留历史，不会再覆盖系统商品或库存。`
        : catalogMirrorPhase === "MISCONFIGURED"
          ? "飞书迁移镜像缺少有效截止时间，系统已安全关闭同步入口；请由系统维护人员补齐配置。"
          : "飞书源货盘始终只读。系统货盘已接管；不会再从飞书覆盖商品或库存。";
  const sourceStatusSummary = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="预检状态"
        value={latestMigrationRun?.statusLabel ?? "尚未执行只读预检"}
      />
      {cargoWritesEnabled ? (
        <Field label="目标同步状态" value={targetSyncState.statusLabel} />
      ) : null}
      <Field
        label="源工作表"
        value={latestMigrationRun?.sourceSheetId ?? "等待选择"}
      />
      {showExpandedSourceFields ? (
        <>
          <Field
            label="源修订号"
            value={latestMigrationRun ? String(latestMigrationRun.sourceRevision) : "—"}
          />
          <Field
            label="源工作表哈希"
            value={latestMigrationRun?.hashSafeSourceSpreadsheet ?? "—"}
          />
          <Field
            label="源快照摘要"
            value={latestMigrationRun?.hashSafeSourceDigest ?? "—"}
          />
        </>
      ) : null}
    </div>
  );
  const migrationSetupPanel =
    actorKind === "SUPER_ADMIN" && !imported ? (
      <WorkspacePanel>
        <WorkspacePanelHeader
          description="先完成只读预检，再用精确语句确认写入本系统数据库。"
          title="数据回填控制"
        />
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <form action={preflightFormAction} className="space-y-3">
            {availableSourceSheets.length > 0 ? (
              <label className="grid gap-2 text-sm font-medium text-foreground">
                源工作表
                <select
                  className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
                  name="sourceSheetId"
                  onChange={(event) => setSelectedSheetId(event.target.value)}
                  value={effectiveSelectedSheetId}
                >
                  <option disabled={hasMultipleSourceSheets} value="">
                    {hasMultipleSourceSheets ? "请选择源工作表" : "使用唯一源工作表"}
                  </option>
                  {availableSourceSheets.map((sheet) => (
                    <option key={sheet.sheetId} value={sheet.sheetId}>
                      {sheet.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : effectiveSelectedSheetId ? (
              <input
                name="sourceSheetId"
                type="hidden"
                value={effectiveSelectedSheetId}
              />
            ) : null}

            {sourceSheetDiscoveryStatus === "error" && sourceSheetDiscoveryMessage ? (
              <div
                className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-foreground"
                role="status"
              >
                {sourceSheetDiscoveryMessage}
              </div>
            ) : null}

            {preflightState.message ? (
              <div
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  actionStateMessageClass(preflightState.status),
                )}
                role={preflightState.status === "error" ? "alert" : "status"}
              >
                {preflightState.message}
              </div>
            ) : null}

            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-border px-4 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
              disabled={!canCreatePreflight || preflightPending}
              type="submit"
            >
              {preflightSubmitLabel}
            </button>
          </form>

          {latestMigrationRun && cargoImportEnabled ? (
            <ConfirmedActionForm
              action={confirmAction}
              className="space-y-4"
              confirmDescription="确认后只会把预检通过的商品元数据、SKU 元数据和图片写入本系统数据库；现有库存余额保持不变。"
              confirmLabel={`确认导入 ${skuCount} 个SKU`}
              confirmTitle={`确认导入 ${skuCount} 个SKU`}
              disabled={!canConfirm || confirmationPhrase !== expectedPhrase}
              onErrorFocus={() => confirmInputRef.current?.focus()}
              submitLabel={`确认迁移 ${skuCount} 个SKU`}
              variant="destructive"
            >
              <input name="runId" type="hidden" value={latestMigrationRun.id} />
              <label className="grid gap-2 text-sm font-medium text-foreground">
                确认语句
                <input
                  aria-label="确认语句"
                  className="min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 py-2 text-sm shadow-[0_1px_1px_oklch(0.23_0.015_185/0.03)] outline-none transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] placeholder:text-muted-foreground/90 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
                  name="confirmationPhrase"
                  onChange={(event) => setConfirmationPhrase(event.target.value)}
                  placeholder={expectedPhrase}
                  ref={confirmInputRef}
                  type="text"
                  value={confirmationPhrase}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                请输入精确语句 {expectedPhrase}，系统才会开放最终确认。
              </p>
            </ConfirmedActionForm>
          ) : null}
        </div>
      </WorkspacePanel>
    ) : null;

  return (
    <div className="space-y-4">
      <WorkspacePanel>
        <WorkspacePanelHeader
          description="只读预检读取飞书；确认后只写入本系统数据库。"
          title="迁移状态总览"
        />
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <div className="rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-foreground">
            {catalogMirrorSummary}
          </div>
          {showMetricSummary ? (
            <MetricStrip
              items={[
                {
                  label: "来源序号",
                  value: String(latestMigrationRun?.summary.sourceSequenceCount ?? 0),
                },
                {
                  label: "SKU 数",
                  value: String(skuCount),
                },
                {
                  label: "图片数",
                  value: String(latestMigrationRun?.summary.imageCount ?? 0),
                },
                {
                  label: "库存总量",
                  value: String(latestMigrationRun?.summary.totalQuantity ?? 0),
                },
              ]}
            />
          ) : null}
          {sourceStatusSummary}
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={badgeToneClass(latestMigrationRun?.statusTone ?? "default")}
              variant="secondary"
            >
              {latestMigrationRun?.statusLabel ?? "尚无预检记录"}
            </Badge>
            {cargoWritesEnabled ? (
              <Badge
                className={badgeToneClass(targetSyncState.tone)}
                variant="secondary"
              >
                {targetSyncState.statusLabel}
              </Badge>
            ) : null}
            {importedCargoBaseline?.importedAtLabel ? (
              <span className="text-xs text-muted-foreground">
                首批导入时间：{importedCargoBaseline.importedAtLabel}
              </span>
            ) : null}
            {importedCargoBaseline?.updatedAtLabel ? (
              <span className="text-xs text-muted-foreground">
                首批迁移记录更新：{importedCargoBaseline.updatedAtLabel}
              </span>
            ) : null}
          </div>
        </div>
      </WorkspacePanel>

      {migrationSetupPanel}

      {actorKind === "SUPER_ADMIN" &&
      importedCargoBaseline &&
      catalogMirrorEnabled ? (
        <WorkspacePanel>
          <WorkspacePanelHeader
            description={`过渡期以飞书为唯一人工维护源；入口将在北京时间 ${catalogMirrorCutoffLabel ?? "配置的截止时间"} 自动关闭。`}
            title="飞书货盘迁移镜像"
          />
          <form action={catalogSyncFormAction} className="space-y-4 px-4 py-4 sm:px-5">
            <div className="space-y-2 text-sm leading-6 text-muted-foreground">
              <p>
                飞书新增的 SKU 会同步创建；已有 SKU 的库存也会按飞书覆盖；本操作不会写入飞书。
              </p>
              <p>
                空字段会保留为空，资料不完整的 SKU 会强制保持不可售。飞书缺失的 SKU 会归档并清零，但不会物理删除历史记录。
              </p>
              <p>
                最近同步：{latestCatalogRefreshLabel ?? "尚未执行"}
              </p>
              <p>任务状态：{catalogMirrorTaskState.statusLabel}</p>
              {catalogMirrorTaskState.isActive ? (
                <p>可以离开本页面，后台任务不会中断。</p>
              ) : null}
              {catalogMirrorTaskState.safeErrorMessage ? (
                <p className="text-danger">
                  最近失败原因：{catalogMirrorTaskState.safeErrorMessage}
                </p>
              ) : null}
            </div>
            <div
              aria-atomic="true"
              aria-live="polite"
              className={cn(
                catalogSyncState.message && "rounded-lg border px-3 py-2 text-sm",
                catalogSyncState.message &&
                  actionStateMessageClass(catalogSyncState.status),
              )}
              role="status"
            >
              {catalogSyncState.message ?? ""}
            </div>
            <button
              aria-busy={catalogSyncPending || catalogMirrorTaskState.isActive}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
              disabled={
                catalogSyncPending ||
                catalogMirrorTaskState.isActive ||
                !sourceConfigured
              }
              type="submit"
            >
              {catalogSyncPending || catalogMirrorTaskState.isActive ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {catalogSyncPending
                ? "正在加入队列"
                : catalogMirrorTaskState.isActive
                  ? "后台同步中"
                  : "一键同步飞书货盘"}
            </button>
          </form>
        </WorkspacePanel>
      ) : null}

      <WorkspacePanel>
        <WorkspacePanelHeader
          description={
            cargoWritesEnabled
              ? "连接验证只读执行；目标测试表重试或重跑只影响派生同步。"
              : "连接验证只读取飞书源货盘，不会修改任何飞书数据。"
          }
          title={cargoWritesEnabled ? "连接与目标同步" : "只读连接"}
        />
        <div
          className={cn(
            "grid gap-4 px-4 py-4 sm:px-5",
            cargoWritesEnabled && "lg:grid-cols-2",
          )}
        >
          <ActionForm
            action={testFeishuConnectionAction}
            className="space-y-3"
            submitLabel="验证只读连接"
          >
            <div className="space-y-2 text-sm leading-6 text-muted-foreground">
              <p>{readOnlyConnectionMessage}</p>
              {actorKind === "SUPER_ADMIN" && sourceSheetDiscoveryMessage ? (
                <p
                  className={cn(
                    "rounded-[var(--radius-surface)] border px-3 py-2 text-sm",
                    sourceSheetDiscoveryStatus === "error"
                      ? "border-warning/30 bg-warning/5 text-foreground"
                      : "border-border bg-muted/40 text-foreground",
                  )}
                >
                  {sourceSheetDiscoveryMessage}
                </p>
              ) : null}
            </div>
          </ActionForm>

          {cargoWritesEnabled ? (
            <ActionForm
              action={retryFeishuCargoSyncAction}
              className="space-y-3"
              submitDisabled={!targetConfigured}
              submitClassName={targetSyncState.canRetry ? undefined : "border-border"}
              submitLabel={syncSubmitLabel}
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {targetConfigured
                    ? targetSyncState.canRetry
                      ? "仅重试目标测试表的失败同步，不会反向改动源业务货盘。"
                      : "按需重新同步目标测试表，不会反向改动源业务货盘。"
                    : "目标测试表尚未配置，当前只能保留只读预检结果。"}
                </p>
                {targetSyncState.rowCount != null ? (
                  <p>最近同步行数：{targetSyncState.rowCount}</p>
                ) : null}
                {targetSyncState.imageCount != null ? (
                  <p>最近同步图片数：{targetSyncState.imageCount}</p>
                ) : null}
                {targetSyncState.lastUpdatedLabel ? (
                  <p>最近同步时间：{targetSyncState.lastUpdatedLabel}</p>
                ) : null}
                {targetSyncState.canRetry && targetSyncState.lastErrorMessage ? (
                  <p>最近失败原因：{targetSyncState.lastErrorMessage}</p>
                ) : null}
              </div>
            </ActionForm>
          ) : null}
        </div>
      </WorkspacePanel>

      <WorkspacePanel>
        <WorkspacePanelHeader
          description="仅显示安全字段，不回显文件 token、表格 token、密钥或临时凭据。"
          title="只读预检明细"
        />
        <div className="space-y-4 px-4 py-4 sm:px-5">
          {latestMigrationRun ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge
                  className={badgeToneClass(latestMigrationRun.statusTone)}
                  variant="secondary"
                >
                  {latestMigrationRun.statusLabel}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  阻断问题 {latestMigrationRun.blockingIssueCount} 项
                </span>
                <span className="text-xs text-muted-foreground">
                  预警问题 {latestMigrationRun.warningIssueCount} 项
                </span>
              </div>
              <CargoPreflightTable rows={latestMigrationRun.rows} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              尚未生成只读预检结果。完成预检后，这里会显示商品、SKU、图片和库存明细。
            </p>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
