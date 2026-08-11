import { desc } from "drizzle-orm";

import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db/client";
import { customers } from "@/db/schema";
import { createCustomerWithStoreAction } from "@/modules/customers/actions";

export default async function CustomersPage() {
  const rows = await db.select().from(customers).orderBy(desc(customers.createdAt));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">客户与店铺</h1>
        <p className="mt-2 text-sm text-muted">管理固定合作店主、客户账号和名下 TEMU 店铺。</p>
      </header>
      <ActionForm action={createCustomerWithStoreAction} className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 xl:grid-cols-[0.8fr_1.2fr_1.2fr_1.3fr_1.2fr_auto] xl:items-end xl:p-5" submitLabel="创建客户与店铺">
        <label className="space-y-2 text-sm font-medium text-ink">客户编号<Input className="min-h-11" maxLength={40} name="code" placeholder="例如 OTTAWA-01" required /></label>
        <label className="space-y-2 text-sm font-medium text-ink">客户名称<Input className="min-h-11" maxLength={160} name="customerName" placeholder="店主或公司名称" required /></label>
        <label className="space-y-2 text-sm font-medium text-ink">店铺名称<Input className="min-h-11" maxLength={160} name="storeName" placeholder="TEMU 店铺名称" required /></label>
        <label className="space-y-2 text-sm font-medium text-ink">登录邮箱<Input autoComplete="email" className="min-h-11" name="email" placeholder="customer@example.com" required type="email" /></label>
        <label className="space-y-2 text-sm font-medium text-ink">初始密码<Input autoComplete="new-password" className="min-h-11" minLength={12} name="password" placeholder="至少 12 个字符" required type="password" /></label>
      </ActionForm>
      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <DataWorkspaceToolbar description="每张拿货单都必须归属具体客户和店铺。" title="合作客户" />
        <ResponsiveDataTable>
          <Table>
            <TableHeader><TableRow><TableHead>客户编号</TableHead><TableHead>客户名称</TableHead><TableHead>联系人</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.length ? rows.map((row) => (
                <TableRow key={row.id}><TableCell className="font-medium">{row.code}</TableCell><TableCell>{row.name}</TableCell><TableCell>{row.contactName ?? "—"}</TableCell><TableCell><Badge className="bg-success/10 text-success" variant="secondary">{row.status === "ACTIVE" ? "启用" : "停用"}</Badge></TableCell></TableRow>
              )) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={4}>暂无客户，使用后续表单创建第一位合作客户。</TableCell></TableRow>}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </section>
    </div>
  );
}
