import { notFound } from "next/navigation";

import { CustomerDetailWorkspace } from "@/components/customers/customer-detail-workspace";
import { getCustomerManagementDetail } from "@/modules/customers/queries";
import { requireAdmin } from "@/modules/identity/guards";

export default async function CustomerDetailPage(props: {
  params: Promise<{ customerId: string }>;
}) {
  const principal = await requireAdmin();
  const { customerId } = await props.params;
  let detail: Awaited<ReturnType<typeof getCustomerManagementDetail>>;

  try {
    detail = await getCustomerManagementDetail(customerId);
  } catch (error) {
    if (error instanceof Error && error.message === "CUSTOMER_NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  return (
    <CustomerDetailWorkspace
      canGovernAccounts={principal.kind === "SUPER_ADMIN"}
      detail={detail}
    />
  );
}
