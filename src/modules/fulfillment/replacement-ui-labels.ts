const replacementStatusLabels = {
  CANCELLED: "已取消",
  EXCEPTION: "异常待处理",
  PENDING_FULFILLMENT: "待履约",
  SHIPPED: "仓库已发货",
} as const;

export function formatReplacementStatus(status: string) {
  return replacementStatusLabels[status as keyof typeof replacementStatusLabels] ?? `未知状态（${status}）`;
}
