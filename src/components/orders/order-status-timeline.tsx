import { Check, Circle, CircleAlert, Clock3 } from "lucide-react";

import { getAdminSettlementOrderStatusLabel } from "@/modules/settlement/admin-ui-labels";
import { formatReplacementStatus } from "@/modules/fulfillment/replacement-ui-labels";

type OrderStatusTimelineProps = {
  orderStatus: string;
  paidAt?: Date | string | null;
  paymentClaimStatus?: string | null;
  refundedAt?: Date | string | null;
  replacementStatuses?: Array<string | null>;
  shipmentStatuses?: Array<string | null>;
};

type TimelineStage = {
  label: string;
  tone?: "danger" | "warning";
};

const shipmentLabels: Record<string, string> = {
  CANCELLED: "包裹已取消",
  CANCEL_PENDING: "包裹取消中",
  EXCEPTION: "仓库处理异常",
  FULFILLING: "待仓库发货",
  PENDING: "待推送履约",
  SHIPPED: "仓库已发货",
  SUBMITTED: "已提交履约",
  SUBMITTING: "正在提交履约",
};

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

function buildStages({
  orderStatus,
  paidAt,
  paymentClaimStatus,
  refundedAt,
  replacementStatuses = [],
  shipmentStatuses = [],
}: OrderStatusTimelineProps): TimelineStage[] {
  const stages: TimelineStage[] = [{ label: "订单已创建" }];

  if (orderStatus === "EXPIRED") {
    stages.push({
      label: getAdminSettlementOrderStatusLabel(orderStatus),
      tone: "danger",
    });
    return stages;
  }

  if (orderStatus === "CANCELLED") {
    if (paidAt) stages.push({ label: "已付款" });
    if (refundedAt) stages.push({ label: "余额已退回" });
    stages.push({ label: getAdminSettlementOrderStatusLabel(orderStatus), tone: "danger" });
    return stages;
  }

  if (orderStatus === "PENDING_PAYMENT") {
    if (paymentClaimStatus === "PENDING") stages.push({ label: "待核款", tone: "warning" });
    else if (paymentClaimStatus === "REJECTED") stages.push({ label: "付款声明已拒绝", tone: "danger" });
    else stages.push({ label: "待付款", tone: "warning" });
    return stages;
  }

  stages.push({ label: "已付款" });

  const shipmentStatus = mostRelevantStatus(shipmentStatuses);
  if (orderStatus === "FULFILLMENT_EXCEPTION" || shipmentStatus === "EXCEPTION") {
    stages.push({ label: "仓库处理异常", tone: "danger" });
  } else if (orderStatus === "SHIPPED" || shipmentStatus === "SHIPPED") {
    stages.push({ label: "仓库已发货" });
  } else if (orderStatus === "FULFILLING" || shipmentStatus) {
    stages.push({ label: shipmentStatus ? (shipmentLabels[shipmentStatus] ?? "待仓库发货") : "待仓库发货" });
  } else {
    stages.push({ label: "待发货", tone: "warning" });
  }

  const replacementStatus = mostRelevantStatus(replacementStatuses);
  if (replacementStatus) {
    const replacementLabel = formatReplacementStatus(replacementStatus);
    stages.push({
      label:
        replacementStatus === "FULFILLING"
          ? "补发待仓库发货"
          : replacementStatus === "SHIPPED"
            ? "补发仓库已发货"
          : replacementStatus === "PENDING_FULFILLMENT"
            ? "待补发"
            : `补发${replacementLabel}`,
      tone: replacementStatus === "EXCEPTION" ? "danger" : undefined,
    });
  }

  return stages;
}

export function OrderStatusTimeline(props: OrderStatusTimelineProps) {
  const stages = buildStages(props);

  return (
    <section
      aria-label="订单状态时间线"
      className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-ink">订单进度</h2>
          <p className="mt-1 text-sm text-muted">按付款、仓库处理和补发的真实状态显示当前进度。</p>
        </div>
        <Clock3 aria-hidden="true" className="size-5 shrink-0 text-primary" />
      </div>
      <ol className="mt-5 grid gap-0 sm:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
        {stages.map((stage, index) => {
          const current = index === stages.length - 1;
          const Icon = stage.tone === "danger" ? CircleAlert : current ? Circle : Check;
          return (
            <li
              className="relative flex min-w-0 gap-3 pb-5 last:pb-0 sm:block sm:pb-0 sm:pr-4"
              key={`${stage.label}-${index}`}
            >
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute left-[11px] top-6 h-[calc(100%-16px)] w-px bg-border sm:left-6 sm:top-[11px] sm:h-px sm:w-[calc(100%-24px)]"
                />
              ) : null}
              <span
                className={`relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background ${
                  stage.tone === "danger"
                    ? "border-danger/40 text-danger"
                    : current
                      ? "border-primary bg-primary text-white"
                      : "border-success/40 text-success"
                }`}
              >
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
              <p
                aria-current={current ? "step" : undefined}
                className={`min-w-0 pt-0.5 text-sm font-medium sm:mt-2 sm:pt-0 ${
                  stage.tone === "danger" ? "text-danger" : current ? "text-ink" : "text-muted"
                }`}
              >
                {stage.label}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export type { OrderStatusTimelineProps };
