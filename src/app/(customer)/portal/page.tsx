import { CustomerTaskDashboard } from "@/components/dashboard/customer-task-dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { getCustomerTaskDashboard } from "@/modules/dashboard/customer-queries";
import { requireCustomer } from "@/modules/identity/guards";

export default async function CustomerPortalPage() {
  const principal = await requireCustomer();
  const dashboard = await getCustomerTaskDashboard(principal.customerId);

  return (
    <div className="space-y-8" data-portal-home>
      <PageHeading
        description="优先完成上传、付款和异常处理，再开始新的拿货流程。"
        title="客户首页"
      />
      <CustomerTaskDashboard dashboard={dashboard} />
    </div>
  );
}
