const replacementStatusLabels = {
  CANCEL_PENDING: "等待极风确认取消",
  CANCELLED: "已取消",
  EXCEPTION: "异常待处理",
  FULFILLING: "待仓库发货",
  PENDING_FULFILLMENT: "待履约",
  SHIPPED: "仓库已发货",
} as const;

export function formatReplacementStatus(status: string) {
  return replacementStatusLabels[status as keyof typeof replacementStatusLabels] ?? `未知状态（${status}）`;
}
