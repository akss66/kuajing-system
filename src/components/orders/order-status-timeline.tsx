import { Check, Circle, CircleAlert, Clock3 } from "lucide-react";

import { formatReplacementStatus } from "@/modules/fulfillment/replacement-ui-labels";
import { getAdminSettlementOrderStatusLabel } from "@/modules/settlement/admin-ui-labels";

type OrderStatusTimelineProps = {
  audience: "admin" | "customer";
  orderStatus: string;
  paidAt?: Date | string | null;
  paymentClaimStatus?: string | null;
  refundedAt?: Date | string | null;
  replacementStatuses?: Array<string | null>;
  shipmentStatuses?: Array<string | null>;
};

type TimelineStageState = "complete" | "current" | "danger" | "upcoming" | "warning";

type TimelineStage = {
  detail?: string;
  label: string;
  state: TimelineStageState;
};

const FULL_FLOW_STAGE_COUNT = 5;

function mostRelevantStatus(statuses: Array<string | null>) {
  const priority = [
    "EXCEPTION",
    "CANCEL_PENDING",
    "FULFILLING",
    "SUBMITTING",
    "SUBMITTED",
    "PENDING_FULFILLMENT",
    "PENDING",
    "SHIPPED",
    "CANCELLED",
  ];
  return priority.find((status) => statuses.includes(status)) ?? null;
}

function terminalStages({
  orderStatus,
  paidAt,
  refundedAt,
}: Pick<OrderStatusTimelineProps, "orderStatus" | "paidAt" | "refundedAt">) {
  const stages: TimelineStage[] = [{ label: "订单已创建", state: "complete" }];

  if (orderStatus === "EXPIRED") {
    stages.push({
      label: getAdminSettlementOrderStatusLabel(orderStatus),
      state: "danger",
    });
    return stages;
  }

  if (paidAt) stages.push({ label: "已付款", state: "complete" });
  if (refundedAt) stages.push({ label: "余额已退回", state: "complete" });
  stages.push({
    label: getAdminSettlementOrderStatusLabel(orderStatus),
    state: "danger",
  });
  return stages;
}

function paymentDetail(paymentClaimStatus?: string | null) {
  if (paymentClaimStatus === "PENDING") return "待核款";
  if (paymentClaimStatus === "REJECTED") return "付款声明已拒绝";
  return "等待付款";
}

function replacementDetail(status: string) {
  const label = formatReplacementStatus(status);
  if (status === "FULFILLING") return "补发待仓库发货";
  if (status === "SHIPPED") return "补发仓库已发货";
  if (status === "PENDING_FULFILLMENT") return "待补发";
  return `补发${label}`;
}

function buildActiveStages({
  audience,
  orderStatus,
  paymentClaimStatus,
  replacementStatuses = [],
  shipmentStatuses = [],
}: OrderStatusTimelineProps): TimelineStage[] {
  const stages: TimelineStage[] = [
    { detail: "创建成功", label: "订单已创建", state: "complete" },
    { detail: "尚未付款", label: "付款确认", state: "upcoming" },
    { detail: "等待付款完成", label: "仓库接单", state: "upcoming" },
    { detail: "尚未开始", label: "仓库处理", state: "upcoming" },
    { detail: "尚未发货", label: "仓库已发货", state: "upcoming" },
  ];

  if (orderStatus === "PENDING_PAYMENT") {
    stages[1] = {
      detail: paymentDetail(paymentClaimStatus),
      label: "付款确认",
      state: paymentClaimStatus === "REJECTED" ? "danger" : "warning",
    };
    return stages;
  }

  stages[1] = { detail: "付款已确认", label: "付款确认", state: "complete" };
  const shipmentStatus = mostRelevantStatus(shipmentStatuses);
  const shippedShipmentCount = shipmentStatuses.filter((status) => status === "SHIPPED").length;
  const cancelledShipmentCount = shipmentStatuses.filter((status) => status === "CANCELLED").length;
  const allShipmentsResolved =
    shipmentStatuses.some((status) => status === "SHIPPED") &&
    shipmentStatuses.every((status) => status === "SHIPPED" || status === "CANCELLED");
  const partiallyCancelled = allShipmentsResolved && cancelledShipmentCount > 0;

  if (orderStatus === "FULFILLMENT_EXCEPTION" || shipmentStatus === "EXCEPTION") {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "仓库处理异常", label: "仓库处理", state: "danger" };
  } else if (orderStatus === "SHIPPED" || allShipmentsResolved) {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "处理完成", label: "仓库处理", state: "complete" };
    stages[4] = partiallyCancelled
      ? {
          detail: `已发出 ${shippedShipmentCount} 个，已取消 ${cancelledShipmentCount} 个`,
          label: "发货与取消",
          state: "complete",
        }
      : { detail: "全部包裹已发出", label: "仓库已发货", state: "complete" };
  } else if (shipmentStatus === "FULFILLING") {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "仓库正在处理", label: "仓库处理", state: "current" };
  } else if (shipmentStatus === "CANCEL_PENDING") {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "包裹取消中", label: "仓库处理", state: "warning" };
  } else if (shipmentStatus === "CANCELLED") {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "包裹已取消", label: "仓库处理", state: "danger" };
  } else if (shipmentStatus === "SUBMITTED") {
    stages[2] = audience === "admin"
      ? {
          detail: "已匹配到极风订单，请在极风后台选择物流渠道并提交仓库；系统随后自动同步。",
          label: "待在极风后台提交仓库",
          state: "current",
        }
      : {
          detail: "已匹配到极风订单，待同舟行选择物流渠道并提交仓库；系统随后自动同步。",
          label: "待同舟行提交仓库",
          state: "current",
        };
  } else if (shipmentStatus === "SUBMITTING") {
    stages[2] = { detail: "正在匹配仓库订单", label: "仓库接单", state: "current" };
  } else if (shipmentStatus === "PENDING") {
    stages[2] = { detail: "等待匹配仓库订单", label: "仓库接单", state: "current" };
  } else if (orderStatus === "FULFILLING") {
    stages[2] = { detail: "仓库已接单", label: "仓库接单", state: "complete" };
    stages[3] = { detail: "仓库正在处理", label: "仓库处理", state: "current" };
  } else {
    stages[2] = { detail: "等待对接仓库", label: "仓库接单", state: "current" };
  }

  const replacementStatus = mostRelevantStatus(replacementStatuses);
  if (replacementStatus) {
    const currentStage = stages.find((stage) => ["current", "danger", "warning"].includes(stage.state));
    if (currentStage?.state === "current") currentStage.state = "complete";
    stages.push({
      detail: replacementDetail(replacementStatus),
      label: "补发处理",
      state:
        replacementStatus === "SHIPPED"
          ? "complete"
          : replacementStatus === "EXCEPTION"
            ? "danger"
            : "current",
    });
  }

  return stages;
}

function buildStages(props: OrderStatusTimelineProps): TimelineStage[] {
  if (["CANCELLED", "EXPIRED"].includes(props.orderStatus)) {
    return terminalStages(props);
  }
  return buildActiveStages(props);
}

function progressValue(stages: TimelineStage[], terminal: boolean) {
  if (terminal) return null;
  const activeIndex = stages.findIndex((stage) =>
    ["current", "danger", "warning"].includes(stage.state),
  );
  if (activeIndex < 0) {
    return stages.every((stage) => stage.state === "complete") ? 100 : 0;
  }
  const progressStepCount =
    stages.length > FULL_FLOW_STAGE_COUNT
      ? stages.length
      : FULL_FLOW_STAGE_COUNT - 1;
  return Math.min(99, Math.round((activeIndex / progressStepCount) * 100));
}

export function OrderStatusTimeline(props: OrderStatusTimelineProps) {
  const stages = buildStages(props);
  const terminal = ["CANCELLED", "EXPIRED"].includes(props.orderStatus);
  const value = progressValue(stages, terminal);
  const complete = !terminal && stages.every((stage) => stage.state === "complete");

  return (
    <section
      aria-label="订单状态时间线"
      className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-ink">订单进度</h2>
          <p className="mt-1 text-sm text-muted">客户端与管理端同步展示付款、仓库接单、处理和发货状态。</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-primary">
          <Clock3 aria-hidden="true" className="size-5 shrink-0" />
          {value === null ? "流程已终止" : complete ? "流程已完成" : `全流程 ${value}%`}
        </div>
      </div>

      {value !== null ? (
        <div
          aria-label="订单全流程进度"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={value}
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
        >
          <span
            aria-hidden="true"
            className="block h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${value}%` }}
          />
        </div>
      ) : null}

      <ol className="mt-4 grid gap-0 sm:mt-5 sm:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
        {stages.map((stage, index) => {
          const current = ["current", "danger", "warning"].includes(stage.state);
          const Icon = stage.state === "danger" ? CircleAlert : stage.state === "complete" ? Check : Circle;
          return (
            <li
              className="relative flex min-w-0 gap-3 pb-3 last:pb-0 sm:block sm:pb-0 sm:pr-4"
              data-state={stage.state}
              key={`${stage.label}-${index}`}
            >
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`absolute left-[11px] top-6 h-[calc(100%-16px)] w-px sm:left-6 sm:top-[11px] sm:h-px sm:w-[calc(100%-24px)] ${
                    stage.state === "complete" ? "bg-success/45" : "bg-border"
                  }`}
                />
              ) : null}
              <span
                className={`relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border ${
                  stage.state === "danger"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : stage.state === "warning"
                      ? "border-warning bg-warning text-white"
                      : stage.state === "current"
                        ? "border-primary bg-primary text-white"
                        : stage.state === "complete"
                          ? "border-success/40 bg-background text-success"
                          : "border-border bg-background text-muted"
                }`}
              >
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
              <div className="min-w-0 pt-0.5 sm:mt-2 sm:pt-0">
                <p className={`text-sm font-semibold ${stage.state === "upcoming" ? "text-muted" : "text-ink"}`}>
                  {stage.label}
                </p>
                {stage.detail ? (
                  <p
                    aria-current={current ? "step" : undefined}
                    className={`mt-0.5 text-xs leading-4 sm:mt-1 sm:leading-5 ${
                      stage.state === "danger"
                        ? "text-danger"
                        : stage.state === "warning"
                          ? "text-warning"
                          : stage.state === "current"
                            ? "text-primary-hover"
                            : "text-muted"
                    }`}
                  >
                    {stage.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export type { OrderStatusTimelineProps };
