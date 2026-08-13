import { notFound } from "next/navigation";

import { CustomerDetailWorkspace } from "@/components/customers/customer-detail-workspace";
import { getCustomerManagementDetail } from "@/modules/customers/queries";

export default async function CustomerDetailPage(props: {
  params: Promise<{ customerId: string }>;
}) {
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

  return <CustomerDetailWorkspace detail={detail} />;
}
