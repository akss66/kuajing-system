import { ArrowRight, Upload } from "lucide-react";
import Link from "next/link";

import { CustomerTaskDashboard } from "@/components/dashboard/customer-task-dashboard";
import { PageHeading } from "@/components/layout/page-heading";
import { getCustomerTaskDashboard } from "@/modules/dashboard/customer-queries";
import { requireCustomer } from "@/modules/identity/guards";

export default async function CustomerPortalPage() {
  const principal = await requireCustomer();
  const dashboard = await getCustomerTaskDashboard(principal.customerId);

  return (
    <div className="space-y-7" data-portal-home>
      <PageHeading
        action={
          <Link className="portal-page-primary inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[0.7rem] bg-primary px-5 text-sm font-semibold text-white outline-none sm:w-auto" href="/portal/imports/new">
            <Upload aria-hidden="true" className="size-4" />
            上传新订单
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
        description="从货盘确认到订单履约，把今天要做的事放在一条清楚的路径上。"
        title="客户首页"
      />
      <CustomerTaskDashboard dashboard={dashboard} />
    </div>
  );
}
