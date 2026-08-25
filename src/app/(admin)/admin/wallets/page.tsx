import { randomUUID } from "node:crypto";

import { ArrowDownLeft, ArrowUpRight, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { AdminFinanceNavigation } from "@/components/settlement/admin-finance-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/modules/identity/guards";
import { adjustWalletAction } from "@/modules/wallet/actions";
import { listAdminWalletAccounts, listAdminWalletTransactions } from "@/modules/wallet/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date | null) {
  if (!value) return "尚无余额变动";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

function value(input: string | string[] | undefined) {
  return Array.isArray(input) ? input[0] : input;
}

export default async function AdminWalletsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const raw = await searchParams;
  const [accounts, transactions] = await Promise.all([
    listAdminWalletAccounts(),
    listAdminWalletTransactions(),
  ]);
  const query = value(raw.q)?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const requestedCustomerId = value(raw.customerId);
  const selectedCustomerId = accounts.some((account) => account.customerId === requestedCustomerId)
    ? requestedCustomerId
    : "";
  const filteredAccounts = query
    ? accounts.filter((account) =>
        `${account.customerCode} ${account.customerName}`.toLocaleLowerCase("zh-CN").includes(query),
      )
    : accounts;
  const totalBalanceFen = accounts.reduce((sum, account) => sum + account.balanceFen, 0);
  const activeAccounts = accounts.filter((account) => account.status === "ACTIVE").length;

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link href="#adjust-balance">人工调整余额</Link>
          </Button>
        }
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "客户余额" }]}
        description="业务管理员和超级管理员都可在这里查看客户余额、执行人工入账或扣减，并核对不可修改的资金流水。系统运维权限仍由超级管理员独占。"
        title="客户余额"
      />
      <AdminFinanceNavigation active="wallets" />
      <MetricStrip
        compact
        items={[
          { hint: "全部客户当前余额之和", label: "余额合计", value: money(totalBalanceFen) },
          { hint: "可正常使用余额的客户", label: "启用账户", value: String(activeAccounts) },
          { hint: "停用客户仍保留历史余额与流水", label: "停用账户", value: String(accounts.length - activeAccounts) },
          { hint: "按时间倒序保留最近记录", label: "最近流水", value: String(transactions.length) },
        ]}
      />

      <WorkspacePanel aria-label="调整客户余额" id="adjust-balance">
        <WorkspacePanelHeader
          compact
          description="业务管理员和超级管理员都可执行。提交前必须二次确认客户、方向、金额和原因；操作会立即生效并写入审计与资金流水。"
          title="调整客户余额"
        />
        <div className="grid gap-5 p-4 lg:grid-cols-[16rem_minmax(0,1fr)] sm:p-5">
          <aside className="rounded-lg border border-warning/30 bg-warning/5 p-4">
            <ShieldCheck aria-hidden="true" className="size-5 text-warning" />
            <p className="mt-3 text-sm font-semibold text-ink">这是现金等价的高风险操作</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              只用于线下收款补录、人工退款修正等明确场景。扣减不能超过客户当前可用余额。
            </p>
          </aside>
          <ConfirmedActionForm
            action={adjustWalletAction}
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1.15fr_0.8fr_0.8fr_1.5fr_auto] xl:items-end"
            confirmDescription="请再次核对客户、增加或扣减方向、金额和原因。确认后会立即改变客户可用余额。"
            confirmLabel="确认执行余额调整"
            confirmTitle="确认执行余额调整？"
            submitLabel="核对并调整"
          >
            <input name="requestId" type="hidden" value={randomUUID()} />
            <label className="space-y-2 text-sm font-medium text-ink">
              客户
              <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue={selectedCustomerId} name="customerId" required>
                <option value="">选择客户</option>
                {accounts.map((account) => (
                  <option key={account.customerId} value={account.customerId}>{`${account.customerCode} · ${account.customerName} · ${money(account.balanceFen)}`}</option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              操作
              <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" defaultValue="" name="operation" required>
                <option value="">选择方向</option>
                <option value="CREDIT">增加余额</option>
                <option value="DEBIT">扣减余额</option>
              </select>
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              金额（元）
              <Input className="min-h-11 tabular-nums" inputMode="decimal" min="0.01" name="amountYuan" placeholder="0.00" required />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              调整原因
              <Input className="min-h-11" maxLength={300} name="reason" placeholder="例如：线下收款补录" required />
            </label>
          </ConfirmedActionForm>
        </div>
      </WorkspacePanel>

      <WorkspacePanel aria-label="客户余额账户" className="overflow-hidden" id="account-balances">
        <WorkspacePanelHeader
          action={
            <form className="flex gap-2">
              <label className="relative min-w-0">
                <span className="sr-only">搜索客户余额</span>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input aria-label="搜索客户余额" className="min-h-10 pl-9" defaultValue={value(raw.q)} name="q" placeholder="客户编号或名称" type="search" />
              </label>
              <Button size="sm" type="submit" variant="outline">搜索</Button>
            </form>
          }
          compact
          description={`当前显示 ${filteredAccounts.length} / ${accounts.length} 个客户。`}
          title="余额账户"
        />
        <ResponsiveDataTable>
          <Table aria-label="客户余额账户">
            <TableHeader><TableRow><TableHead>客户</TableHead><TableHead className="text-right">当前余额</TableHead><TableHead>最近更新</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {filteredAccounts.map((account) => (
                <TableRow key={account.customerId}>
                  <TableCell><p className="font-semibold text-ink">{account.customerCode}</p><p className="mt-1 text-xs text-muted">{account.customerName}</p></TableCell>
                  <TableCell className="text-right text-base font-semibold tabular-nums">{money(account.balanceFen)}</TableCell>
                  <TableCell className="text-sm text-muted">{dateTime(account.updatedAt)}</TableCell>
                  <TableCell><Badge className={account.status === "ACTIVE" ? "bg-success/10 text-success" : "bg-surface-muted text-muted"} variant="secondary">{account.status === "ACTIVE" ? "启用" : "停用"}</Badge></TableCell>
                  <TableCell className="text-right"><Button asChild size="sm" variant="outline"><Link href={`/admin/wallets?customerId=${account.customerId}#adjust-balance`}>调整</Link></Button></TableCell>
                </TableRow>
              ))}
              {!filteredAccounts.length ? <TableRow><TableCell className="h-28 text-center text-muted" colSpan={5}>没有符合条件的客户。</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>

      <WorkspacePanel aria-label="最近资金流水" className="overflow-hidden">
        <WorkspacePanelHeader compact description="最近 100 条，按时间倒序；每笔记录均不可修改。" title="资金流水" />
        {transactions.length ? (
          <ResponsiveDataTable>
            <Table aria-label="客户资金流水">
              <TableHeader><TableRow><TableHead>时间（渥太华）</TableHead><TableHead>客户</TableHead><TableHead>类型</TableHead><TableHead>原因 / 拿货单</TableHead><TableHead className="text-right">变动</TableHead><TableHead className="text-right">变动后</TableHead></TableRow></TableHeader>
              <TableBody>{transactions.map((transaction) => (
                <TableRow key={transaction.id}>
                  <TableCell className="text-muted">{dateTime(transaction.createdAt)}</TableCell>
                  <TableCell><p className="font-medium">{transaction.customerCode}</p><p className="text-xs text-muted">{transaction.customerName}</p></TableCell>
                  <TableCell>{transaction.deltaFen > 0 ? <span className="inline-flex items-center gap-1 text-success"><ArrowDownLeft aria-hidden="true" className="size-4" />入账</span> : <span className="inline-flex items-center gap-1 text-danger"><ArrowUpRight aria-hidden="true" className="size-4" />扣款</span>}</TableCell>
                  <TableCell><p>{transaction.reason}</p>{transaction.orderNumber ? <p className="mt-1 text-xs text-muted">{transaction.orderNumber}</p> : null}</TableCell>
                  <TableCell className={`text-right font-semibold tabular-nums ${transaction.deltaFen > 0 ? "text-success" : "text-danger"}`}>{transaction.deltaFen > 0 ? "+" : "−"}{money(Math.abs(transaction.deltaFen))}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(transaction.afterBalanceFen)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </ResponsiveDataTable>
        ) : <div className="px-5 py-10 text-center text-sm text-muted" role="status">暂无资金流水。</div>}
      </WorkspacePanel>
    </div>
  );
}
