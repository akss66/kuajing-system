import { CustomerListWorkspace } from "@/components/customers/customer-list-workspace";
import { listCustomerManagementRows } from "@/modules/customers/queries";
import { requireAdmin } from "@/modules/identity/guards";

export default async function CustomersPage() {
  const principal = await requireAdmin();
  const rows = await listCustomerManagementRows();

  return (
    <CustomerListWorkspace
      canGovernAccounts={principal.kind === "SUPER_ADMIN"}
      rows={rows}
    />
  );
}
