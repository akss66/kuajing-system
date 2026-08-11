import { desc } from "drizzle-orm";
import { BellRing } from "lucide-react";

import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { db } from "@/db/client";
import { systemNotifications } from "@/db/schema";
import { markNotificationReadAction } from "@/modules/notifications/actions";

export default async function NotificationsPage() {
  const notifications = await db.select().from(systemNotifications).orderBy(desc(systemNotifications.lastOccurredAt)).limit(200);
  return <div className="space-y-6"><header><p className="text-sm font-medium text-primary">异常与提醒</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">系统通知</h1><p className="mt-2 text-sm text-muted">这里与内部飞书群同步展示履约异常、补发和低库存提醒。</p></header><section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"><div className="divide-y divide-border">{notifications.length ? notifications.map((notification) => <article className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5" key={notification.id}><div className="flex gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"><BellRing className="size-5" /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-ink">{notification.title}</h2><Badge className={notification.severity === "ERROR" ? "bg-danger/10 text-danger" : notification.severity === "WARNING" ? "bg-warning/10 text-warning" : "bg-primary-soft text-primary-hover"} variant="secondary">{notification.severity}</Badge>{notification.occurrenceCount > 1 ? <span className="text-xs text-muted">累计 {notification.occurrenceCount} 次</span> : null}</div><p className="mt-2 text-sm text-muted">{notification.message}</p><p className="mt-2 text-xs text-muted">{notification.lastOccurredAt.toLocaleString("zh-CN")}</p></div></div>{notification.status === "UNREAD" ? <ActionForm action={markNotificationReadAction} className="shrink-0" submitLabel="标记已读"><input name="notificationId" type="hidden" value={notification.id} /></ActionForm> : <Badge className="w-fit bg-surface-muted text-muted" variant="secondary">已读</Badge>}</article>) : <div className="p-12 text-center text-sm text-muted">暂无系统通知。</div>}</div></section></div>;
}
