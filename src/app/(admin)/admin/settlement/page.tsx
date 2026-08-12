import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ActionForm } from "@/components/forms/action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { PaymentClaimReview } from "@/components/orders/payment-claim-review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listPendingPaymentClaims } from "@/modules/orders/queries";
import { listAdminSettlementBatches } from "@/modules/settlement/admin-queries";
import { adjustWalletAction } from "@/modules/wallet/actions";
import { listAdminWalletAccounts, listAdminWalletTransactions } from "@/modules/wallet/queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function dateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function SettlementPage() {
  const [accounts, transactions, pendingClaims] = await Promise.all([
    listAdminWalletAccounts(),
    listAdminWalletTransactions(),
    listPendingPaymentClaims(),
  ]);
  const pendingBatchCount = (await listAdminSettlementBatches({ status: "PAYMENT_REPORTED" })).length;
  const totalBalanceFen = accounts.reduce((sum, account) => sum + account.balanceFen, 0);

  return (
    <div className="space-y-5">
      <PageHeading
        description="线下微信收款后可为客户充值；所有增加和扣减都会留下不可变流水。"
        title="收款与余额"
      />

      <MetricStrip
        items={[
          { hint: "等待管理员核款", label: "待核款", tone: pendingClaims.length ? "warning" : "default", value: String(pendingClaims.length) },
          { hint: "所有客户钱包余额", label: "客户余额合计", value: money(totalBalanceFen) },
          { hint: "已启用客户钱包账户", label: "钱包账户", value: String(accounts.length) },
          { hint: `${pendingBatchCount} 个批次待审`, label: "最近流水", value: String(transactions.length) },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <WorkspacePanel as="div" className="p-5 transition-colors hover:bg-surface">
          <Link className="block" href="/admin/settlement-batches">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-ink">统一结算批次</h2>
                <p className="mt-1 text-sm text-muted">
                  进入批次级统一核款工作台，查看余额抵扣、微信待付、审计与整批确认/拒绝。
                </p>
              </div>
              <Badge variant="secondary">{`待审核 ${pendingBatchCount}`}</Badge>
            </div>
          </Link>
        </WorkspacePanel>

        <WorkspacePanel as="div" className="p-5 transition-colors hover:bg-surface">
          <Link className="block" href="/admin/bulk-orders">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-ink">批量草稿诊断</h2>
                <p className="mt-1 text-sm text-muted">
                  只读查看客户多店铺草稿的文件摘要、冲突、错误码与部分提交结果。
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <span>查看批量草稿</span>
              </Button>
            </div>
          </Link>
        </WorkspacePanel>
      </div>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="只核对客户为当前拿货单支付的微信款；确认后直接进入待发货，不经过钱包。"
          title="待核款"
        />
        {pendingClaims.length ? (
          <div className="divide-y divide-border">
            {pendingClaims.map((claim) => (
              <article className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[1fr_1.45fr] xl:items-center" key={claim.claimId}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink">{claim.orderNumber}</p>
                    <Badge className="bg-warning/10 text-warning" variant="secondary">
                      待核款
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted">
                    {claim.customerCode} · {claim.customerName} · {claim.storeName}
                  </p>
                  <p className="mt-2 text-xl font-semibold tabular-nums text-ink">{money(claim.amountFen)}</p>
                  <p className="mt-1 text-xs text-muted">申报于 {dateTime(claim.createdAt)}（渥太华）</p>
                  {claim.note ? <p className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">备注：{claim.note}</p> : null}
                </div>
                <PaymentClaimReview amountFen={claim.amountFen} claimId={claim.claimId} orderNumber={claim.orderNumber} />
              </article>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10 text-center text-sm text-muted" role="status">
            暂无需要核对的微信付款。
          </div>
        )}
      </WorkspacePanel>

      <WorkspacePanel className="p-4 sm:p-5">
        <ActionForm
          action={adjustWalletAction}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1.1fr_0.8fr_0.8fr_1.6fr_auto] xl:items-end"
          submitLabel="确认调整余额"
        >
          <label className="space-y-2 text-sm font-medium text-ink">
            客户
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="customerId" required>
              <option value="">选择客户</option>
              {accounts.map((account) => (
                <option key={account.customerId} value={account.customerId}>
                  {account.customerCode} · {account.customerName}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            操作
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="operation" required>
              <option value="CREDIT">增加余额</option>
              <option value="DEBIT">扣减余额</option>
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            金额（元）
            <Input className="min-h-11 tabular-nums" inputMode="decimal" min="0.01" name="amountYuan" placeholder="500.00" required />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            调整原因
            <Input className="min-h-11" maxLength={300} name="reason" placeholder="例如：收到微信转账" required />
          </label>
        </ActionForm>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="订单提交时余额足够会自动扣款，无需管理员确认。"
          title="客户钱包"
        />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="text-right">当前余额</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={account.customerId}>
                  <TableCell className="font-semibold">{account.customerCode}</TableCell>
                  <TableCell>{account.customerName}</TableCell>
                  <TableCell className="text-right text-base font-semibold tabular-nums">{money(account.balanceFen)}</TableCell>
                  <TableCell>
                    <Badge className={account.status === "ACTIVE" ? "bg-success/10 text-success" : "bg-surface-muted text-muted"} variant="secondary">
                      {account.status === "ACTIVE" ? "启用" : "停用"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader description="按时间倒序展示最近 100 条。" title="资金流水" />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间（渥太华）</TableHead>
                <TableHead>客户</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>原因 / 拿货单</TableHead>
                <TableHead className="text-right">变动</TableHead>
                <TableHead className="text-right">变动后</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.length ? (
                transactions.map((transaction) => (
                  <TableRow key={transaction.id}>
                    <TableCell className="text-muted">{dateTime(transaction.createdAt)}</TableCell>
                    <TableCell>
                      <p className="font-medium">{transaction.customerCode}</p>
                      <p className="text-xs text-muted">{transaction.customerName}</p>
                    </TableCell>
                    <TableCell>
                      {transaction.deltaFen > 0 ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <ArrowDownLeft className="size-4" />
                          入账
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <ArrowUpRight className="size-4" />
                          扣款
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <p>{transaction.reason}</p>
                      {transaction.orderNumber ? <p className="mt-1 text-xs text-muted">{transaction.orderNumber}</p> : null}
                    </TableCell>
                    <TableCell className={`text-right font-semibold tabular-nums ${transaction.deltaFen > 0 ? "text-success" : "text-danger"}`}>
                      {transaction.deltaFen > 0 ? "+" : "−"}
                      {money(Math.abs(transaction.deltaFen))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(transaction.afterBalanceFen)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-28 text-center text-muted" colSpan={6}>
                    暂无资金流水。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>
    </div>
  );
}
