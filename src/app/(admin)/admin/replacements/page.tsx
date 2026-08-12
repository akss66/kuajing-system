import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { fulfillmentOrders, replacementRequests } from "@/db/schema";

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

      <MetricStrip
        items={[
          { label: "最近记录", value: `${rows.length}` },
          {
            label: "处理中",
            value: `${rows.filter((row) => !["SHIPPED", "CANCELLED"].includes(row.status)).length}`,
          },
          {
            label: "已完成",
            value: `${rows.filter((row) => row.status === "SHIPPED").length}`,
          },
        ]}
      />

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="补发入口仍保留在订单详情页，这里只负责查看补发原因、状态和回跳路径。"
          title="补发记录"
        />
        <div className="divide-y divide-border">
          {rows.length ? (
            rows.map((row, index) => (
              <div
                className="grid gap-3 p-4 sm:grid-cols-[1fr_1.5fr_auto_auto] sm:items-center sm:px-5"
                key={`${row.orderId}-${index}`}
              >
                <div>
                  <p className="font-semibold text-ink">{row.orderNumber}</p>
                  <p className="mt-1 text-xs text-muted">
                    {row.createdAt.toLocaleString("zh-CN")}
                  </p>
                </div>
                <p className="text-sm text-muted">{row.reason}</p>
                <Badge className="w-fit bg-primary-soft text-primary-hover" variant="secondary">
                  {row.status}
                </Badge>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/orders/${row.orderId}`}>查看订单</Link>
                </Button>
              </div>
            ))
          ) : (
            <div className="p-12 text-center text-sm text-muted">
              暂无补发记录，请从已发货订单中创建。
            </div>
          )}
        </div>
      </WorkspacePanel>
    </div>
  );
}
