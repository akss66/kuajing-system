import type { ManagedAccountSummary } from "@/modules/accounts/queries";

export function formatAccountDateTime(value: Date | string | null) {
  if (!value) return "暂无记录";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(date);
}

export function accountKindLabel(kind: ManagedAccountSummary["kind"]) {
  if (kind === "SUPER_ADMIN") return "超级管理员";
  if (kind === "ADMIN") return "普通管理员";
  return "客户账号";
}

export function accountStatusLabel(status: ManagedAccountSummary["status"]) {
  return status === "ACTIVE" ? "启用中" : "已停用";
}
