import { desc } from "drizzle-orm";
import { AlertTriangle, BellRing, CheckCircle2, Info } from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/forms/action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { systemNotifications } from "@/db/schema";
import { markNotificationReadAction } from "@/modules/notifications/actions";

function severityPresentation(severity: "INFO" | "WARNING" | "ERROR") {
  if (severity === "ERROR") return { className: "bg-danger/10 text-danger", icon: AlertTriangle, label: "严重" };
  if (severity === "WARNING") return { className: "bg-warning/10 text-warning", icon: AlertTriangle, label: "警告" };
  return { className: "bg-primary-soft text-primary-hover", icon: Info, label: "提示" };
}

function impactLabel(entityType: string | null) {
  if (entityType === "SKU") return "影响库存";
  if (entityType === "FULFILLMENT_ORDER" || entityType === "ORDER_SHIPMENT") return "影响订单履约";
  if (entityType === "REPLACEMENT_REQUEST") return "影响补发";
  if (entityType === "SETTLEMENT_BATCH") return "影响结算";
  return "影响系统运营";
}

function resolutionLabel(status: "UNREAD" | "READ" | "RESOLVED") {
  if (status === "UNREAD") return "未读";
  if (status === "READ") return "已查看";
  return "已解决";
}

export default async function NotificationsPage() {
  const notifications = await db
    .select()
    .from(systemNotifications)
    .orderBy(desc(systemNotifications.lastOccurredAt))
    .limit(200);

  const openNotifications = notifications.filter((notification) => notification.status !== "RESOLVED");
  const archivedNotifications = notifications.filter((notification) => notification.status === "RESOLVED");

  function notificationRow(notification: (typeof notifications)[number]) {
    const severity = severityPresentation(notification.severity);
    const SeverityIcon = severity.icon;
    return (
      <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between" key={notification.id}>
        <div className="flex min-w-0 gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface-muted text-muted-foreground">
            <BellRing aria-hidden="true" className="size-5" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-ink">{notification.title}</h3>
              <Badge className={severity.className} variant="secondary"><SeverityIcon aria-hidden="true" />{severity.label}</Badge>
              <Badge variant="outline">{impactLabel(notification.entityType)}</Badge>
              <Badge className={notification.status === "RESOLVED" ? "bg-success/10 text-success" : "bg-surface-muted text-muted"} variant="secondary">
                {notification.status === "RESOLVED" ? <CheckCircle2 aria-hidden="true" /> : null}{resolutionLabel(notification.status)}
              </Badge>
              {notification.occurrenceCount > 1 ? <span className="text-xs tabular-nums text-muted">累计 {notification.occurrenceCount} 次</span> : null}
            </div>
            <p className="text-sm leading-6 text-muted">{notification.message}</p>
            <time className="block text-xs tabular-nums text-muted" dateTime={notification.lastOccurredAt.toISOString()}>{notification.lastOccurredAt.toLocaleString("zh-CN")}</time>
          </div>
        </div>
        {notification.status === "UNREAD" ? (
          <ActionForm action={markNotificationReadAction} className="shrink-0" submitLabel="标记已读">
            <input name="notificationId" type="hidden" value={notification.id} />
          </ActionForm>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "系统通知" },
        ]}
        description="同步展示仓库处理异常、补发提醒与库存预警，不暴露客户隐私字段。"
        title="系统通知"
      />

      {notifications.length === 0 ? (
        <ActionableEmptyState
          action={<Button asChild size="sm" variant="outline"><Link href="/admin/system/health">查看系统健康</Link></Button>}
          description="当前没有履约、库存或集成异常。可前往系统健康查看最近一次只读检查。"
          kind="initial"
          title="当前没有系统通知"
        />
      ) : null}

      <section aria-labelledby="open-notifications-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div><h2 className="text-base font-semibold text-foreground" id="open-notifications-title">需要处理</h2><p className="mt-1 text-sm text-muted-foreground">按最近发生时间排列；标记已读不会改变原始事件或解决状态。</p></div>
          <span className="text-sm tabular-nums text-muted-foreground">{openNotifications.length} 项</span>
        </div>
        {openNotifications.length > 0 ? <ul className="divide-y divide-border border-b border-border">{openNotifications.map(notificationRow)}</ul> : <p className="py-5 text-sm text-muted-foreground" role="status">当前没有未解决通知。</p>}
      </section>

      <section aria-labelledby="archived-notifications-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div><h2 className="text-base font-semibold text-foreground" id="archived-notifications-title">已归档通知</h2><p className="mt-1 text-sm text-muted-foreground">保留已解决事件，便于回看影响范围和发生时间。</p></div>
          <span className="text-sm tabular-nums text-muted-foreground">{archivedNotifications.length} 项</span>
        </div>
        {archivedNotifications.length > 0 ? <ul className="divide-y divide-border border-b border-border">{archivedNotifications.map(notificationRow)}</ul> : <p className="py-5 text-sm text-muted-foreground" role="status">暂无已解决通知。</p>}
      </section>
    </div>
  );
}
