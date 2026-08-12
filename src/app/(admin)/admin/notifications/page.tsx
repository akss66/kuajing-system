import { desc } from "drizzle-orm";
import { BellRing } from "lucide-react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ActionForm } from "@/components/forms/action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db/client";
import { systemNotifications } from "@/db/schema";
import { markNotificationReadAction } from "@/modules/notifications/actions";

export default async function NotificationsPage() {
  const notifications = await db
    .select()
    .from(systemNotifications)
    .orderBy(desc(systemNotifications.lastOccurredAt))
    .limit(200);

  const unreadCount = notifications.filter(
    (notification) => notification.status === "UNREAD",
  ).length;
  const errorCount = notifications.filter(
    (notification) => notification.severity === "ERROR",
  ).length;
  const warningCount = notifications.filter(
    (notification) => notification.severity === "WARNING",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "系统通知" },
        ]}
        description="同步展示履约异常、补发提醒与库存预警，不暴露客户隐私字段。"
        title="系统通知"
      />

      <MetricStrip
        items={[
          { label: "最近 200 条", value: `${notifications.length}` },
          {
            label: "未读提醒",
            tone: unreadCount > 0 ? "warning" : "default",
            value: `${unreadCount}`,
          },
          {
            label: "错误级别",
            tone: errorCount > 0 ? "danger" : "default",
            value: `${errorCount}`,
          },
          {
            label: "警告级别",
            tone: warningCount > 0 ? "warning" : "default",
            value: `${warningCount}`,
          },
        ]}
      />

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="按最近发生时间倒序排列。标记已读只影响通知状态，不改变原始事件记录。"
          title="通知队列"
        />
        <div className="divide-y divide-border">
          {notifications.length ? (
            notifications.map((notification) => (
              <article
                className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:px-5"
                key={notification.id}
              >
                <div className="flex gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                    <BellRing className="size-5" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-ink">{notification.title}</h2>
                      <Badge
                        className={
                          notification.severity === "ERROR"
                            ? "bg-danger/10 text-danger"
                            : notification.severity === "WARNING"
                              ? "bg-warning/10 text-warning"
                              : "bg-primary-soft text-primary-hover"
                        }
                        variant="secondary"
                      >
                        {notification.severity}
                      </Badge>
                      {notification.occurrenceCount > 1 ? (
                        <span className="text-xs text-muted">
                          累计 {notification.occurrenceCount} 次
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted">{notification.message}</p>
                    <p className="text-xs text-muted">
                      {notification.lastOccurredAt.toLocaleString("zh-CN")}
                    </p>
                  </div>
                </div>
                {notification.status === "UNREAD" ? (
                  <ActionForm
                    action={markNotificationReadAction}
                    className="shrink-0"
                    submitLabel="标记已读"
                  >
                    <input
                      name="notificationId"
                      type="hidden"
                      value={notification.id}
                    />
                  </ActionForm>
                ) : (
                  <Badge className="w-fit bg-surface-muted text-muted" variant="secondary">
                    已读
                  </Badge>
                )}
              </article>
            ))
          ) : (
            <div className="px-6 py-16 text-center text-sm text-muted">
              暂无系统通知。
            </div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
