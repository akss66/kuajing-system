const batchStatusLabels = {
  CANCELLED: "已关闭",
  EXPIRED: "已超时",
  PAID: "已收款",
  PAYMENT_REPORTED: "等待统一核款",
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
  FULFILLING: "履约中",
  FULFILLMENT_EXCEPTION: "履约异常",
  PAID_PENDING_FULFILLMENT: "已付款 / 待发货",
  PENDING_PAYMENT: "待付款",
  SHIPPED: "已发货",
} as const;

const walletHoldStatusLabels = {
  ACTIVE: "冻结中",
  CONSUMED: "已抵扣",
  RELEASED: "已释放",
} as const;

const bulkDraftLifecycleStatusLabels = {
  COMPLETED: "全部店铺已提交",
  DRAFT: "草稿待提交",
  EXPIRED: "草稿已过期",
  PARTIALLY_SUBMITTED: "部分店铺已提交",
} as const;

const bulkDraftValidationStatusLabels = {
  ALREADY_SUBMITTED: "已提交",
  BLOCKED_CROSS_STORE: "跨店冲突",
  BLOCKED_INVALID: "格式问题",
  BLOCKED_INVENTORY: "库存变化",
  BLOCKED_UNKNOWN_SKU: "未映射 SKU",
  EMPTY: "无可提交订单",
  EXPIRED: "已过期",
  SUBMITTABLE: "可提交",
} as const;

const settlementAuditActionLabels = {
  SETTLEMENT_PAYMENT_APPROVED: "管理员已确认到账",
  SETTLEMENT_PAYMENT_EXPIRED: "付款声明已过期",
  SETTLEMENT_PAYMENT_REJECTED: "管理员已拒绝付款声明",
  SETTLEMENT_PAYMENT_REPORTED: "客户提交付款声明",
  SETTLEMENT_PAYMENT_WITHDRAWN: "客户已撤回付款声明",
} as const;

const bulkDraftErrorLabels = {
  CROSS_STORE_FILE: "检测到跨店文件",
  CROSS_STORE_SUB_ORDER: "检测到跨店子订单",
  DRAFT_EXPIRED: "草稿已过期",
  FILE_EXPIRED: "文件已过期",
  GROUP_ALREADY_SUBMITTED: "该店铺已生成拿货单",
  INSUFFICIENT_STOCK: "库存不足",
  INVALID_ROW: "存在格式问题",
  NO_VALID_ORDERS: "没有可提交订单",
  UNKNOWN_SKU: "存在未映射 SKU",
} as const;

export function getAdminSettlementBatchStatusLabel(status: string) {
  return batchStatusLabels[status as keyof typeof batchStatusLabels] ?? "处理中";
}

export function getAdminSettlementClaimStatusLabel(status: string | null) {
  if (!status) return "未声明";
  return claimStatusLabels[status as keyof typeof claimStatusLabels] ?? "未声明";
}

export function getAdminSettlementOrderStatusLabel(status: string) {
  return orderStatusLabels[status as keyof typeof orderStatusLabels] ?? "处理中";
}

export function getAdminWalletHoldStatusLabel(status: string | null) {
  if (!status) return "未冻结";
  return walletHoldStatusLabels[status as keyof typeof walletHoldStatusLabels] ?? "处理中";
}

export function getAdminBulkDraftStatusLabel(status: string) {
  return bulkDraftLifecycleStatusLabels[
    status as keyof typeof bulkDraftLifecycleStatusLabels
  ] ?? "状态处理中";
}

export function getAdminBulkDraftValidationLabel(status: string) {
  return bulkDraftValidationStatusLabels[
    status as keyof typeof bulkDraftValidationStatusLabels
  ] ?? "诊断处理中";
}

export function getAdminBulkDraftErrorLabel(code: string) {
  return bulkDraftErrorLabels[code as keyof typeof bulkDraftErrorLabels] ?? code;
}

export function getAdminSettlementAuditActionLabel(action: string) {
  return settlementAuditActionLabels[
    action as keyof typeof settlementAuditActionLabels
  ] ?? "结算记录已更新";
}
