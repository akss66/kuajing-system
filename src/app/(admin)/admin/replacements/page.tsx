import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { fulfillmentOrders, replacementRequests } from "@/db/schema";

export default async function ReplacementsPage() {
  const rows = await db.select({ createdAt: replacementRequests.createdAt, orderId: replacementRequests.orderId, orderNumber: fulfillmentOrders.orderNumber, reason: replacementRequests.reason, status: replacementRequests.status }).from(replacementRequests).innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, replacementRequests.orderId)).orderBy(desc(replacementRequests.createdAt)).limit(300);
  return <div className="space-y-6"><header><p className="text-sm font-medium text-primary">售后履约</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">补发管理</h1><p className="mt-2 text-sm text-muted">补发从已发货订单详情创建，并独立追踪极风和加拿大邮政状态。</p></header><section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"><div className="divide-y divide-border">{rows.length ? rows.map((row, index) => <div className="grid gap-3 p-4 sm:grid-cols-[1fr_1.5fr_auto_auto] sm:items-center sm:p-5" key={`${row.orderId}-${index}`}><div><p className="font-semibold text-ink">{row.orderNumber}</p><p className="mt-1 text-xs text-muted">{row.createdAt.toLocaleString("zh-CN")}</p></div><p className="text-sm text-muted">{row.reason}</p><Badge className="w-fit bg-primary-soft text-primary-hover" variant="secondary">{row.status}</Badge><Button asChild size="sm" variant="outline"><Link href={`/admin/orders/${row.orderId}`}>查看订单</Link></Button></div>) : <div className="p-12 text-center text-sm text-muted">暂无补发记录，请从已发货订单中创建。</div>}</div></section></div>;
}
