"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import {
  WorkspacePanel,
  WorkspacePanelHeader,
} from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CargoMigrationActionState } from "@/modules/feishu/actions";
import type {
  CargoMigrationPanelRun,
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
  cargoWritesEnabled: boolean;
  confirmCargoMigrationAction?: ManagedAction;
  createCargoPreflightAction: PreflightManagedAction;
  latestMigrationRun: CargoMigrationPanelRun | null;
  readOnlyConnectionMessage: string;
  retryFeishuCargoSyncAction: ManagedAction;
  selectedSourceSheetId: string | null;
  sourceConfigured: boolean;
  sourceSheetDiscoveryMessage: string | null;
  sourceSheetDiscoveryStatus: "error" | "idle" | "ready";
  sourceSheetOptions: SourceSheetOption[];
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
  cargoWritesEnabled,
  confirmCargoMigrationAction,
  createCargoPreflightAction,
  latestMigrationRun,
  readOnlyConnectionMessage,
  retryFeishuCargoSyncAction,
  selectedSourceSheetId,
  sourceConfigured,
  sourceSheetDiscoveryMessage,
  sourceSheetDiscoveryStatus,
  sourceSheetOptions,
  targetConfigured,
  targetSyncState,
  testFeishuConnectionAction,
}: CargoMigrationPanelProps) {
  const [preflightState, preflightFormAction, preflightPending] = useActionState(
    createCargoPreflightAction,
    INITIAL_ACTION_STATE as CargoMigrationActionState,
  );
  const [selectedSheetId, setSelectedSheetId] = useState(() => {
    if (selectedSourceSheetId) return selectedSourceSheetId;
    return sourceSheetOptions.length === 1 ? sourceSheetOptions[0].sheetId : "";
  });
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const confirmInputRef = useRef<HTMLInputElement>(null);

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
  const imported = latestMigrationRun?.status === "IMPORTED";
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
  const targetWriteControlsDisabled = targetConfigured && !cargoWritesEnabled;
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
  const sourceStatusSummary = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="预检状态"
        value={latestMigrationRun?.statusLabel ?? "尚未执行只读预检"}
      />
      <Field
        label="目标同步状态"
        value={targetSyncState.statusLabel}
      />
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
          description="先完成只读预检，再用精确语句确认首批导入。"
          title="首批迁移控制"
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
              confirmDescription="确认后会把预检通过的首批商品、SKU 和图片正式写入系统。"
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
          description="源业务货盘始终只读，迁移确认和目标同步是两条独立链路。"
          title="迁移状态总览"
        />
        <div className="space-y-3 px-4 py-4 sm:px-5">
          {targetWriteControlsDisabled ? (
            <div className="rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-foreground">
              只读发布：已配置目标测试表，但 FEISHU_CARGO_WRITES_ENABLED 未显式设为 true。当前只允许连接验证和源货盘只读预检。
            </div>
          ) : null}
          <div className="rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-foreground">
            原业务货盘受保护，系统不会写入。
          </div>
          {showMetricSummary ? (
            <MetricStrip
              items={[
                {
                  label: "商品数",
                  value: String(latestMigrationRun?.summary.productCount ?? 0),
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
            <Badge
              className={badgeToneClass(targetSyncState.tone)}
              variant="secondary"
            >
              {targetSyncState.statusLabel}
            </Badge>
            {latestMigrationRun?.importedAtLabel ? (
              <span className="text-xs text-muted-foreground">
                导入时间：{latestMigrationRun.importedAtLabel}
              </span>
            ) : null}
            {latestMigrationRun?.updatedAtLabel ? (
              <span className="text-xs text-muted-foreground">
                最近更新：{latestMigrationRun.updatedAtLabel}
              </span>
            ) : null}
          </div>
        </div>
      </WorkspacePanel>

      {migrationSetupPanel}

      <WorkspacePanel>
        <WorkspacePanelHeader
          description="连接验证只读执行；目标测试表重试或重跑只影响派生同步。"
          title="连接与目标同步"
        />
        <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-2">
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

          <ActionForm
            action={retryFeishuCargoSyncAction}
            className="space-y-3"
            submitDisabled={targetWriteControlsDisabled || !targetConfigured}
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
