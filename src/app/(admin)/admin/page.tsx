import { AdminOperationsDashboard } from "@/components/dashboard/admin-operations-dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { getAdminOperationsDashboard } from "@/modules/dashboard/admin-queries";

export default async function AdminOverviewPage() {
  const dashboard = await getAdminOperationsDashboard();

  return (
    <div className="space-y-6">
      <PageHeading
        description="集中查看今日订单、待办异常与近 7 天真实经营变化。"
        title="运营总览"
      />
      <AdminOperationsDashboard dashboard={dashboard} />
    </div>
  );
}
