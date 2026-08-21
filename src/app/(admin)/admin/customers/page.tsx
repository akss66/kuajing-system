import { CustomerListWorkspace } from "@/components/customers/customer-list-workspace";
import { listCustomerManagementRows } from "@/modules/customers/queries";
import { requireAdmin } from "@/modules/identity/guards";

export default async function CustomersPage() {
  const principal = await requireAdmin();
  const canGovernAccounts = principal.kind === "SUPER_ADMIN";
  const rows = await listCustomerManagementRows({
    includeAccountIdentity: canGovernAccounts,
  });

  return (
    <CustomerListWorkspace
      canGovernAccounts={canGovernAccounts}
      rows={rows}
    />
  );
}
