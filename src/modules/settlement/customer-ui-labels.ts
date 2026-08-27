const batchStatusLabels = {
  CANCELLED: "已关闭",
  EXPIRED: "已超时",
  PAID: "已收款",
  PAYMENT_REPORTED: "待审核",
  PENDING_PAYMENT: "待付款",
  REJECTED: "已拒绝",
  WITHDRAWN: "已撤回",
} as const;

const claimStatusLabels = {
  APPROVED: "已核准",
  PENDING: "待审核",
  REJECTED: "已拒绝",
  WITHDRAWN: "已撤回",
} as const;

const orderStatusLabels = {
  CANCELLED: "已取消",
  EXPIRED: "已超时",
  FULFILLING: "仓库处理中",
  FULFILLMENT_EXCEPTION: "需要协助",
  PAID_PENDING_FULFILLMENT: "已付款 / 待发货",
  PENDING_PAYMENT: "待付款",
  SHIPPED: "已发货",
} as const;

const walletHoldStatusLabels = {
  ACTIVE: "冻结中",
  CONSUMED: "已抵扣",
  RELEASED: "已释放",
} as const;

export function getCustomerSettlementBatchStatusLabel(status: string) {
  return batchStatusLabels[status as keyof typeof batchStatusLabels] ?? "待付款";
}

export function getCustomerSettlementClaimStatusLabel(status: string | null) {
  if (!status) return "未声明";
  return claimStatusLabels[status as keyof typeof claimStatusLabels] ?? "未声明";
}

export function getCustomerSettlementOrderStatusLabel(status: string) {
  return orderStatusLabels[status as keyof typeof orderStatusLabels] ?? "处理中";
}

export function getCustomerWalletHoldStatusLabel(status: string) {
  return walletHoldStatusLabels[status as keyof typeof walletHoldStatusLabels] ?? "处理中";
}
