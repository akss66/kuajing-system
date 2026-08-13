"use client";

import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  PlugZap,
  ShieldCheck,
} from "lucide-react";
import { useActionState, useEffect, useRef } from "react";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  authorizeJifengConnectionAction,
  disconnectJifengConnectionAction,
  discoverJifengResourcesAction,
  runJifengDiagnosticAction,
  selectJifengResourcesAction,
  setJifengFulfillmentAction,
  type JifengActionState,
} from "@/modules/jifeng-connection/actions";
import type { JifengConnectionStatus } from "@/modules/jifeng-connection/types";
import { INITIAL_ACTION_STATE } from "@/shared/action-state";

type ConnectionSummary = {
  fulfillmentEnabled: boolean;
  lastDiagnosticAt: Date | null;
  status: JifengConnectionStatus;
};

type ConnectionDetails = {
  authorizedAt: Date | null;
  developerIdMasked: string | null;
  lastError: { code: string; summary: string } | null;
  lastRefreshedAt: Date | null;
  logistics: { id: number; name: string | null } | null;
  userIdMasked: string | null;
  warehouse: { code: string; name: string | null } | null;
};

export type JifengConnectionCardProps = {
  canManage: boolean;
  connection: ConnectionSummary;
  details?: ConnectionDetails;
};

const statusContent: Record<
  JifengConnectionStatus,
  {
    consequence: string;
    label: string;
    nextStep: string;
    tone: "danger" | "success" | "warning" | "default";
  }
> = {
  DISCONNECTED: {
    consequence: "不会向极风发送订单。",
    label: "未连接",
    nextStep: "使用一次性令牌完成授权。",
    tone: "default",
  },
  AUTHORIZED: {
    consequence: "自动履约保持关闭。",
    label: "已授权，待发现资源",
    nextStep: "重新发现可用仓库和物流渠道。",
    tone: "warning",
  },
  RESOURCE_SELECTION_REQUIRED: {
    consequence: "不会默认选择任何仓库或渠道。",
    label: "待选择履约资源",
    nextStep: "明确选择仓库和物流渠道。",
    tone: "warning",
  },
  READY_DISABLED: {
    consequence: "订单仍留在本系统，不会自动推送。",
    label: "已就绪，自动履约未启用",
    nextStep: "运行最新诊断并确认启用。",
    tone: "warning",
  },
  ENABLED: {
    consequence: "符合条件的已付款订单会自动推送到极风。",
    label: "自动履约已启用",
    nextStep: "异常时先停用自动履约，再检查连接。",
    tone: "success",
  },
  REFRESH_REQUIRED: {
    consequence: "自动推单已被阻止。",
    label: "授权需要更新",
    nextStep: "获取新的一次性令牌并重新授权。",
    tone: "warning",
  },
  ERROR: {
    consequence: "当前连接不可用于履约。",
    label: "连接异常",
    nextStep: "重新授权；若仍失败请联系系统维护人员。",
    tone: "danger",
  },
};

const toneClass = {
  danger: "bg-danger/10 text-danger",
  default: "bg-surface-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
};

function formatDate(value: Date | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)
    : "暂无";
}

function AuthorizationForm() {
  const [state, formAction, pending] = useActionState<JifengActionState, FormData>(
    authorizeJifengConnectionAction,
    INITIAL_ACTION_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.status === "idle") return;
    if (tokenRef.current) tokenRef.current.value = "";
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  const errors = Object.values(state.fieldErrors ?? {}).flat();

  return (
    <form
      action={formAction}
      className="grid gap-4 sm:grid-cols-2"
      ref={formRef}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-ink" htmlFor="jifeng-email">
          极风授权邮箱
        </label>
        <Input
          autoComplete="email"
          id="jifeng-email"
          maxLength={254}
          name="email"
          required
          type="email"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-ink" htmlFor="jifeng-token">
          一次性令牌
        </label>
        <Input
          aria-describedby="jifeng-token-hint"
          autoComplete="one-time-code"
          id="jifeng-token"
          maxLength={512}
          minLength={16}
          name="oneTimeToken"
          ref={tokenRef}
          required
          type="password"
        />
        <p className="text-xs leading-5 text-muted" id="jifeng-token-hint">
          令牌只用于本次请求，不会回显或保存在表单中。
        </p>
      </div>
      {errors.length || state.message ? (
        <div
          className={
            state.status === "success"
              ? "rounded-[var(--radius-control)] border border-success/20 bg-success/5 px-3 py-2 text-sm text-success sm:col-span-2"
              : "rounded-[var(--radius-control)] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger sm:col-span-2"
          }
          role={state.status === "error" ? "alert" : "status"}
        >
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          {state.message ? <p>{state.message}</p> : null}
        </div>
      ) : null}
      <Button className="min-h-11 w-fit px-4" disabled={pending} type="submit">
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
        {pending ? "正在授权" : "完成极风授权"}
      </Button>
    </form>
  );
}

function ResourceDiscoveryForm() {
  const [state, formAction, pending] = useActionState<JifengActionState, FormData>(
    discoverJifengResourcesAction,
    INITIAL_ACTION_STATE,
  );
  const resources = state.resources;

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-2">
        <p className="text-sm leading-6 text-muted">
          每次确认前都会重新读取极风可用资源，避免使用过期选项。
        </p>
        {state.message ? (
          <p
            className={
              state.status === "error"
                ? "text-sm text-danger"
                : "text-sm text-success"
            }
            role={state.status === "error" ? "alert" : "status"}
          >
            {state.message}
          </p>
        ) : null}
        <Button className="min-h-11" disabled={pending} type="submit" variant="outline">
          {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
          {pending ? "正在发现资源" : "重新发现资源"}
        </Button>
      </form>

      {resources ? (
        resources.warehouses.length > 0 && resources.logistics.length > 0 ? (
          <ActionForm
            action={selectJifengResourcesAction}
            className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2"
            submitLabel="确认履约资源"
          >
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium text-ink" htmlFor="warehouse-code">
                选择极风仓库
              </label>
              <select
                className="min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18 md:text-sm"
                id="warehouse-code"
                name="warehouseCode"
                required
              >
                <option value="">请选择仓库</option>
                {resources.warehouses.map((warehouse) => (
                  <option key={warehouse.code} value={warehouse.code}>
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium text-ink" htmlFor="logistics-id">
                选择物流渠道
              </label>
              <select
                className="min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18 md:text-sm"
                id="logistics-id"
                name="logisticsId"
                required
              >
                <option value="">请选择物流渠道</option>
                {resources.logistics.map((logistics) => (
                  <option key={logistics.id} value={logistics.id}>
                    {logistics.name}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm leading-6 text-warning" role="status">
            未发现可用的仓库或物流渠道。请在极风后台检查授权范围后重新发现。
          </p>
        )
      ) : null}
    </div>
  );
}

function ReasonInput({ id, label }: { id: string; label: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-ink" htmlFor={id}>
        {label}
      </label>
      <Input id={id} maxLength={500} minLength={2} name="reason" required />
    </div>
  );
}

function ConnectionActions({ status }: { status: JifengConnectionStatus }) {
  const needsAuthorization =
    status === "DISCONNECTED" || status === "REFRESH_REQUIRED" || status === "ERROR";
  const needsResources =
    status === "AUTHORIZED" || status === "RESOURCE_SELECTION_REQUIRED";
  const canDiagnose = status === "READY_DISABLED" || status === "ENABLED";

  return (
    <div className="space-y-5 px-4 py-5 sm:px-5">
      {needsAuthorization ? <AuthorizationForm /> : null}
      {needsResources ? <ResourceDiscoveryForm /> : null}
      {canDiagnose ? (
        <ActionForm
          action={runJifengDiagnosticAction}
          className="space-y-2"
          submitLabel="运行只读诊断"
        >
          <p className="text-sm leading-6 text-muted">
            只验证已保存授权与订单读取能力，不创建、取消或修改订单。
          </p>
        </ActionForm>
      ) : null}

      {status === "READY_DISABLED" ? (
        <ConfirmedActionForm
          action={setJifengFulfillmentAction}
          className="space-y-3 border-t border-border pt-5"
          confirmDescription="启用后，符合条件的已付款订单会自动发送到极风并进入真实仓库履约。"
          confirmLabel="确认启用自动履约"
          confirmTitle="确认启用极风自动履约？"
          submitLabel="启用自动履约"
        >
          <input name="enabled" type="hidden" value="true" />
          <ReasonInput id="jifeng-enable-reason" label="启用原因" />
        </ConfirmedActionForm>
      ) : null}

      {status === "ENABLED" ? (
        <ActionForm
          action={setJifengFulfillmentAction}
          className="space-y-3 border-t border-border pt-5"
          submitLabel="停用自动履约"
        >
          <input name="enabled" type="hidden" value="false" />
          <ReasonInput id="jifeng-disable-reason" label="停用原因" />
          <p className="text-xs leading-5 text-muted">
            停用后不再创建新的极风履约任务；既有订单和审计记录保留。
          </p>
        </ActionForm>
      ) : null}

      {status !== "DISCONNECTED" ? (
        <ConfirmedActionForm
          action={disconnectJifengConnectionAction}
          className="space-y-3 border-t border-border pt-5"
          confirmDescription="系统会先停用自动履约，再清除已保存的授权凭证和资源选择；历史订单与审计记录不会删除。"
          confirmLabel="确认断开连接"
          confirmTitle="确认断开极风连接？"
          submitLabel="断开极风连接"
        >
          <ReasonInput id="jifeng-disconnect-reason" label="断开原因" />
        </ConfirmedActionForm>
      ) : null}
    </div>
  );
}

function Details({ details }: { details: ConnectionDetails }) {
  const rows = [
    ["开发者 ID", details.developerIdMasked ?? "未配置"],
    ["极风用户", details.userIdMasked ?? "未授权"],
    ["授权时间", formatDate(details.authorizedAt)],
    ["最近刷新", formatDate(details.lastRefreshedAt)],
    ["极风仓库", details.warehouse?.name ?? "未选择"],
    ["物流渠道", details.logistics?.name ?? "未选择"],
  ];

  return (
    <div className="border-b border-border px-4 py-4 sm:px-5">
      <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-xs font-medium text-muted">{label}</dt>
            <dd className="mt-1 break-words text-sm text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {details.lastError ? (
        <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-warning" role="status">
          <AlertTriangle aria-hidden="true" className="mt-1 size-4 shrink-0" />
          最近一次连接错误已安全记录。请按当前状态的下一步指引处理。
        </p>
      ) : null}
    </div>
  );
}

export function JifengConnectionCard({
  canManage,
  connection,
  details,
}: JifengConnectionCardProps) {
  const content = statusContent[connection.status];
  const StatusIcon = connection.status === "ENABLED" ? CheckCircle2 : ShieldCheck;

  return (
    <WorkspacePanel className="min-w-0 overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-primary-soft text-primary">
            <PlugZap aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-ink">极风 WMS 连接</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
              管理官方授权、加拿大仓库、物流渠道和真实订单自动履约开关。
            </p>
          </div>
        </div>
        <Badge className={toneClass[content.tone]} variant="secondary">
          <StatusIcon aria-hidden="true" className="size-3.5" />
          {content.label}
        </Badge>
      </div>

      <div className="grid gap-3 border-b border-border bg-surface-muted/45 px-4 py-4 text-sm sm:grid-cols-2 sm:px-5">
        <p className="min-w-0 leading-6 text-ink">
          <span className="font-medium">当前后果：</span>
          {content.consequence}
        </p>
        <p className="min-w-0 leading-6 text-ink">
          <span className="font-medium">下一步：</span>
          {content.nextStep}
        </p>
      </div>

      {canManage && details ? <Details details={details} /> : null}

      {canManage ? (
        <ConnectionActions status={connection.status} />
      ) : (
        <div className="px-4 py-5 sm:px-5">
          <p className="font-medium text-ink">只读状态</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            只有超级管理员可以更改授权、资源和自动履约状态。
          </p>
        </div>
      )}
    </WorkspacePanel>
  );
}
