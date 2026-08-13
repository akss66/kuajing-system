import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { fulfillmentOrders, replacementRequests } from "@/db/schema";
import { formatReplacementStatus } from "@/modules/fulfillment/replacement-ui-labels";

export default async function ReplacementsPage() {
  const rows = await db
    .select({
      createdAt: replacementRequests.createdAt,
      orderId: replacementRequests.orderId,
      orderNumber: fulfillmentOrders.orderNumber,
      reason: replacementRequests.reason,
      status: replacementRequests.status,
    })
    .from(replacementRequests)
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, replacementRequests.orderId))
    .orderBy(desc(replacementRequests.createdAt))
    .limit(300);
  const pendingRows = rows.filter((row) => !["SHIPPED", "CANCELLED"].includes(row.status));
  const historyRows = rows.filter((row) => ["SHIPPED", "CANCELLED"].includes(row.status));

  function replacementRow(row: (typeof rows)[number], index: number) {
    return (
      <li
        className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1.5fr)_auto_auto] sm:items-center"
        key={`${row.orderId}-${index}`}
      >
        <div className="min-w-0">
          <p className="truncate font-semibold tabular-nums text-ink">{row.orderNumber}</p>
          <p className="mt-1 text-xs tabular-nums text-muted">
            {row.createdAt.toLocaleString("zh-CN")}
          </p>
        </div>
        <p className="text-sm leading-6 text-muted">{row.reason}</p>
        <Badge className="w-fit bg-primary-soft text-primary-hover" variant="secondary">
          {formatReplacementStatus(row.status)}
        </Badge>
        <Button asChild className="w-fit" size="sm" variant="outline">
          <Link href={`/admin/orders/${row.orderId}`}>查看订单</Link>
        </Button>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "补发管理" },
        ]}
        description="补发从已发货订单详情创建，并独立跟踪仓储与物流状态。"
        title="补发管理"
      />

      <section aria-labelledby="replacement-queue-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div>
            <h2 className="text-base font-semibold text-foreground" id="replacement-queue-title">待处理补发</h2>
            <p className="mt-1 text-sm text-muted-foreground">按最近创建时间排列，优先回到订单处理履约异常。</p>
          </div>
          <span className="text-sm tabular-nums text-muted-foreground">{pendingRows.length} 项</span>
        </div>
        {pendingRows.length > 0 ? (
          <ul className="divide-y divide-border border-b border-border">
            {pendingRows.map(replacementRow)}
          </ul>
        ) : (
          <ActionableEmptyState
            action={<Button asChild size="sm" variant="outline"><Link href="/admin/orders?status=SHIPPED">查看已发货订单</Link></Button>}
            description="当前没有需要继续跟进的补发。新补发仍从已发货订单详情发起。"
            kind="initial"
            title="当前没有待处理补发"
          />
        )}
      </section>

      <section aria-labelledby="replacement-history-title" className="space-y-3">
        <div className="flex items-end justify-between gap-4 border-b border-border pb-3">
          <div>
            <h2 className="text-base font-semibold text-foreground" id="replacement-history-title">补发历史</h2>
            <p className="mt-1 text-sm text-muted-foreground">已发货与已取消记录保留原因、状态和订单回跳路径。</p>
          </div>
          <span className="text-sm tabular-nums text-muted-foreground">{historyRows.length} 项</span>
        </div>
        {historyRows.length > 0 ? (
          <ul className="divide-y divide-border border-b border-border">
            {historyRows.map(replacementRow)}
          </ul>
        ) : <p className="py-5 text-sm text-muted-foreground" role="status">暂无已完成或已取消的补发记录。</p>}
      </section>
    </div>
  );
}
