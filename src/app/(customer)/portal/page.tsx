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
    <div className="space-y-8" data-portal-home>
      <PageHeading
        action={
          <Link className="portal-page-primary inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[0.7rem] bg-primary px-5 text-sm font-semibold text-white outline-none sm:w-auto" href="/portal/imports/new">
            <Upload aria-hidden="true" className="size-4" />
            开始上传
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
        description="优先完成上传、付款和异常处理，再开始新的拿货流程。"
        title="客户首页"
      />
      <CustomerTaskDashboard dashboard={dashboard} />
    </div>
  );
}
