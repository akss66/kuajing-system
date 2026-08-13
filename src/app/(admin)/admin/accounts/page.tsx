import { AccountManagementWorkspace } from "@/components/accounts/account-management-workspace";
import { PageHeading } from "@/components/layout/page-heading";
import { listManagedAccounts } from "@/modules/accounts/queries";
import { requireAdmin } from "@/modules/identity/guards";
import { z } from "zod";

type AccountsPageProps = {
  searchParams?: Promise<{ customerId?: string | string[] }>;
};

const customerIdSchema = z.string().trim().uuid();

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

export default async function AccountsPage({ searchParams }: AccountsPageProps = {}) {
  const principal = await requireAdmin();
  if (principal.kind !== "SUPER_ADMIN") {
    return <AccessDeniedState />;
  }

  const rawCustomerId = searchParams ? (await searchParams).customerId : undefined;
  const parsedCustomerId =
    typeof rawCustomerId === "string" ? customerIdSchema.safeParse(rawCustomerId) : null;
  const focusedCustomerId = parsedCustomerId?.success ? parsedCustomerId.data : undefined;

  return (
    <AccountManagementWorkspace
      accounts={await listManagedAccounts()}
      focusedCustomerId={focusedCustomerId}
      key={focusedCustomerId ?? "all-accounts"}
    />
  );
}
