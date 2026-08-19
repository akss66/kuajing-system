const auditActionLabels: Record<string, string> = {
  ACCOUNT_CREATED: "账号创建",
  ACCOUNT_PASSWORD_RESET: "账号密码重置",
  ACCOUNT_STATUS_CHANGED: "账号状态变更",
  ACCOUNT_UPDATED: "账号资料更新",
  BULK_IMPORT_DRAFT_CREATED: "批量草稿创建",
  CUSTOMER_CREATED: "客户创建",
  CUSTOMER_PRICE_SET: "客户价格设置",
  CUSTOMER_STATUS_CHANGED: "客户状态变更",
  CUSTOMER_UPDATED: "客户资料更新",
  FULFILLMENT_ORDER_CANCELLED: "订单取消",
  FULFILLMENT_ORDER_EXPIRED: "订单超时",
  FULFILLMENT_ORDER_SUBMITTED: "订单提交",
  INVENTORY_ADJUSTED: "库存调整",
  JIFENG_FULFILLMENT_EXCEPTION: "极风仓库处理异常",
  JIFENG_ORDER_RECONCILED: "极风订单对账完成",
  JIFENG_ORDER_RECONCILIATION_REQUIRED: "极风订单需要对账",
  JIFENG_ORDER_SUBMISSION_FAILED: "极风订单推送失败",
  JIFENG_ORDER_SUBMITTED: "极风订单已推送",
  JIFENG_SHIPMENT_CANCEL_FAILED: "极风取消发货失败",
  JIFENG_SHIPMENT_CANCELLED: "极风发货已取消",
  JIFENG_SHIPMENT_RETRY_REQUESTED: "极风发货已请求重试",
  JIFENG_SHIPMENT_SHIPPED: "极风确认发货",
  JIFENG_STATUS_POLL_FAILED: "极风状态同步失败",
  OFFLINE_PAYMENT_APPROVED: "线下付款已核准",
  OFFLINE_PAYMENT_DECLARED: "线下付款已申报",
  OFFLINE_PAYMENT_REJECTED: "线下付款已拒绝",
  REPLACEMENT_CREATED: "补发创建",
  SETTLEMENT_CANCELLED: "统一结算已关闭",
  SETTLEMENT_EXPIRED: "统一结算已超时",
  SETTLEMENT_PAID: "统一结算已收款",
  SETTLEMENT_PAYMENT_APPROVED: "统一付款已核准",
  SETTLEMENT_PAYMENT_EXPIRED: "统一付款申报已过期",
  SETTLEMENT_PAYMENT_REJECTED: "统一付款申报已拒绝",
  SETTLEMENT_PAYMENT_REPORTED: "统一付款已申报",
  SETTLEMENT_PAYMENT_WITHDRAWN: "统一付款申报已撤回",
  SKU_ALIAS_CREATED: "SKU 别名创建",
  SKU_CREATED: "SKU 创建",
  STORE_CREATED: "店铺创建",
  STORE_STATUS_CHANGED: "店铺状态变更",
  STORE_UPDATED: "店铺资料更新",
  TEMU_IMPORT_PREVIEW_CREATED: "TEMU 导入预览创建",
  TEMU_IMPORT_PREVIEW_RECLASSIFIED: "TEMU 导入预览重新分类",
  WALLET_ADJUSTED: "钱包人工调整",
  WALLET_ORDER_DEBITED: "订单余额扣款",
  WALLET_ORDER_REFUNDED: "订单余额退款",
  WALLET_SETTLEMENT_DEBITED: "统一结算余额扣款",
  WALLET_SETTLEMENT_HELD: "统一结算余额冻结",
  WALLET_SETTLEMENT_HOLD_CONSUMED: "统一结算冻结已抵扣",
  WALLET_SETTLEMENT_HOLD_RELEASED: "统一结算冻结已释放",
};

const auditEntityLabels: Record<string, string> = {
  ACCOUNT: "账号",
  BULK_IMPORT_DRAFT: "批量导入草稿",
  BULK_SUBMISSION: "批量提交",
  CUSTOMER: "客户",
  CUSTOMER_WALLET: "客户钱包",
  FULFILLMENT_ORDER: "履约订单",
  ORDER_IMPORT_BATCH: "订单导入批次",
  ORDER_SHIPMENT: "订单包裹",
  REPLACEMENT_REQUEST: "补发请求",
  SETTLEMENT_BATCH: "统一结算批次",
  SHIPMENT_FULFILLMENT: "仓储履约任务",
  SKU: "SKU",
  SKU_ALIAS: "SKU 别名",
  SKU_INVENTORY: "SKU 库存",
  SKU_PRICE: "SKU 客户价",
  STORE: "店铺",
};

export const auditActionOptions = Object.entries(auditActionLabels).map(([value, label]) => ({
  label,
  value,
}));

export const auditEntityOptions = Object.entries(auditEntityLabels).map(([value, label]) => ({
  label,
  value,
}));

export function formatAuditActorType(actorType: string) {
  if (actorType === "ADMIN") return "管理员";
  if (actorType === "CUSTOMER") return "客户";
  return "系统任务";
}

export function formatAuditAction(action: string) {
  return auditActionLabels[action] ?? "其他审计事件";
}

export function formatAuditEntity(entityType: string) {
  return auditEntityLabels[entityType] ?? "其他业务对象";
}
