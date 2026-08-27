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
        description="总览店铺、订单、付款与异常，并继续下一步拿货。"
        title="经营概览"
      />
      <CustomerTaskDashboard dashboard={dashboard} />
    </div>
  );
}
