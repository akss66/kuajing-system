import { CustomerPortalBrandAccent } from "@/components/dashboard/customer-portal-brand-accent";
import { CustomerTaskDashboard } from "@/components/dashboard/customer-task-dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { getCustomerTaskDashboard } from "@/modules/dashboard/customer-queries";
import { requireCustomer } from "@/modules/identity/guards";

export default async function CustomerPortalPage() {
  const principal = await requireCustomer();
  const dashboard = await getCustomerTaskDashboard(principal.customerId);

  return (
    <div className="space-y-6" data-portal-home>
      <PageHeading
        action={<CustomerPortalBrandAccent />}
        description="查看当前待办，快速开始下一次拿货。"
        title="客户首页"
      />
      <CustomerTaskDashboard dashboard={dashboard} />
    </div>
  );
}
