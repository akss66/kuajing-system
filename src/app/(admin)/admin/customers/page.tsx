import { CustomerListWorkspace } from "@/components/customers/customer-list-workspace";
import { listCustomerManagementRows } from "@/modules/customers/queries";

export default async function CustomersPage() {
  const rows = await listCustomerManagementRows();

  return <CustomerListWorkspace rows={rows} />;
}
