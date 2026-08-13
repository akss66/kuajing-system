import { AccountManagementWorkspace } from "@/components/accounts/account-management-workspace";
import { PageHeading } from "@/components/layout/page-heading";
import { listManagedAccounts } from "@/modules/accounts/queries";
import { requireAdmin } from "@/modules/identity/guards";

function AccessDeniedState() {
  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "账号管理受限" }]}
        description="只有超级管理员可以查看、创建或停用账号。"
        title="账号管理受限"
      />
      <section className="border border-warning/25 bg-warning/5 px-5 py-5 text-sm text-warning">
        普通管理员仍可继续处理客户与店铺的日常管理，但账号治理操作不会在这里暴露。
      </section>
    </div>
  );
}

export default async function AccountsPage() {
  const principal = await requireAdmin();
  if (principal.kind !== "SUPER_ADMIN") {
    return <AccessDeniedState />;
  }

  return <AccountManagementWorkspace accounts={await listManagedAccounts()} />;
}
