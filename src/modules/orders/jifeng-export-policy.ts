export const JIFENG_EXPORTABLE_ORDER_STATUSES = [
  "PAID_PENDING_FULFILLMENT",
  "FULFILLING",
  "FULFILLMENT_EXCEPTION",
] as const;

export const JIFENG_EXPORTABLE_SHIPMENT_STATUSES = [
  "PENDING",
  "SUBMITTING",
  "SUBMITTED",
  "EXCEPTION",
] as const;

export function canExportOrderToJifeng(status: string): boolean {
  return (JIFENG_EXPORTABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function jifengExportBlockedReason(status: string): string {
  if (status === "PENDING_PAYMENT") return "未付款，不可导出";
  if (status === "SHIPPED") return "已发货，不可重复导出";
  return "订单已结束，不可导出";
}
