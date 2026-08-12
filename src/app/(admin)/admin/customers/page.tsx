import Link from "next/link";

import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createCustomerWithStoreAction } from "@/modules/customers/actions";
import { listCustomerManagementRows } from "@/modules/customers/queries";

function accountStatusLabel(status: "ACTIVE" | "DISABLED" | null) {
  if (status === "ACTIVE") return "账号正常";
  if (status === "DISABLED") return "账号已停用";
  return "未同步账号";
}

export default async function CustomersPage() {
  const rows = await listCustomerManagementRows();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">客户与店铺</h1>
        <p className="mt-2 text-sm text-muted">管理固定合作客户、唯一客户账号，以及其名下的多家 TEMU 店铺。</p>
      </header>
      <ActionForm
        action={createCustomerWithStoreAction}
        className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 xl:grid-cols-[0.8fr_1.1fr_1.1fr_1.2fr_1.1fr_1.5fr_auto] xl:items-end xl:p-5"
        submitLabel="创建客户与店铺"
      >
        <label className="space-y-2 text-sm font-medium text-ink">
          客户编号
          <Input className="min-h-11" maxLength={40} name="code" placeholder="例如 OTTAWA-01" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          客户名称
          <Input className="min-h-11" maxLength={160} name="customerName" placeholder="店主或公司名称" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          店铺名称
          <Input className="min-h-11" maxLength={160} name="storeName" placeholder="TEMU 店铺名称" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          登录邮箱
          <Input autoComplete="email" className="min-h-11" name="email" placeholder="customer@example.com" required type="email" />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          初始密码
          <Input autoComplete="new-password" className="min-h-11" minLength={12} name="password" placeholder="至少 12 位" required type="password" />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          创建原因
          <Input className="min-h-11" maxLength={500} name="reason" placeholder="说明为什么要创建该客户账号" required />
        </label>
      </ActionForm>
      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <DataWorkspaceToolbar description="每一张拿货单都必须归属于具体客户与店铺；账号状态和店铺覆盖范围在这里集中查看。" title="合作客户" />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户编号</TableHead>
                <TableHead>客户名称</TableHead>
                <TableHead>联系人</TableHead>
                <TableHead>账号状态</TableHead>
                <TableHead>店铺数</TableHead>
                <TableHead>客户状态</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => (
                  <TableRow key={row.customerId}>
                    <TableCell className="font-medium">{row.code}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.contactName ?? "—"}</TableCell>
                    <TableCell>{accountStatusLabel(row.accountStatus)}</TableCell>
                    <TableCell>{`${row.storeCount} 家店铺`}</TableCell>
                    <TableCell>
                      <Badge className={row.status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"} variant="secondary">
                        {row.status === "ACTIVE" ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/customers/${row.customerId}`}>查看详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-28 text-center text-muted" colSpan={7}>
                    暂无客户，使用上方表单创建第一位合作客户。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </section>
    </div>
  );
}
