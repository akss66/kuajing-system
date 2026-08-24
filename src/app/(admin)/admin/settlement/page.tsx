import { randomUUID } from "node:crypto";

import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { PageHeading } from "@/components/layout/page-heading";
import { PaymentClaimReview } from "@/components/orders/payment-claim-review";
import {
  SettlementRegion,
  SettlementWorkspace,
} from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listPendingPaymentClaims } from "@/modules/orders/queries";
import { requireAdmin } from "@/modules/identity/guards";
import {
  listAdminSettlementBatches,
  listPendingOfflineRefunds,
} from "@/modules/settlement/admin-queries";
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

function refundAge(value: Date, now = new Date()) {
  const elapsedDays = Math.max(
    0,
    Math.floor((now.getTime() - value.getTime()) / (24 * 60 * 60 * 1_000)),
  );
  return elapsedDays === 0 ? "等待不足 1 天" : `已等待 ${elapsedDays} 天`;
}

export default async function SettlementPage() {
  const principal = await requireAdmin();
  const [accounts, transactions, pendingClaims, pendingBatches, pendingRefunds] = await Promise.all([
    listAdminWalletAccounts(),
    listAdminWalletTransactions(),
    listPendingPaymentClaims(),
    listAdminSettlementBatches({ status: "PAYMENT_REPORTED" }),
    listPendingOfflineRefunds(),
  ]);
  const totalBalanceFen = accounts.reduce((sum, account) => sum + account.balanceFen, 0);

  return (
    <div className="space-y-5">
      <PageHeading
        description="先处理待核款，再查看批量付款记录、客户余额与不可变资金流水。"
        title="收款与余额"
      />

      <MetricStrip
        items={[
          {
            hint: `单张拿货单 ${pendingClaims.length} · 批量付款 ${pendingBatches.length}`,
            label: "待核款",
            tone: pendingClaims.length + pendingBatches.length ? "warning" : "default",
            value: String(pendingClaims.length + pendingBatches.length),
          },
          { hint: "已取消包裹的微信退款", label: "待线下退款", tone: pendingRefunds.length ? "warning" : "default", value: String(pendingRefunds.length) },
          { hint: "所有客户钱包余额", label: "客户余额合计", value: money(totalBalanceFen) },
          { hint: "已启用客户钱包账户", label: "钱包账户", value: String(accounts.length) },
        ]}
      />

      <SettlementWorkspace>
        <SettlementRegion
          description="只核对客户为当前拿货单支付的微信款；确认后直接进入待发货，不经过钱包。"
          kind="review"
        >
          {pendingClaims.length ? (
            <div className="divide-y divide-border">
              {pendingClaims.map((claim) => (
                <article className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[1fr_1.45fr] xl:items-center" key={claim.claimId}>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-ink">{claim.orderNumber}</p>
                      <Badge className="bg-warning/10 text-warning" variant="secondary">待核款</Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted">{`${claim.customerCode} · ${claim.customerName} · ${claim.storeName}`}</p>
                    <p className="mt-2 text-xl font-semibold tabular-nums text-ink">{money(claim.amountFen)}</p>
                    <p className="mt-1 text-xs text-muted">申报于 {dateTime(claim.createdAt)}（渥太华）</p>
                    {claim.note ? <p className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">备注：{claim.note}</p> : null}
                  </div>
                  <PaymentClaimReview amountFen={claim.amountFen} claimId={claim.claimId} orderNumber={claim.orderNumber} />
                </article>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-muted" role="status">暂无需要核对的微信付款。</div>
          )}
        </SettlementRegion>

        <SettlementRegion
          description="已取消且使用微信线下付款的包裹，需要人工退款；完成后会自动移出本列表。"
          id="pending-offline-refunds"
          kind="refunds"
        >
          {pendingRefunds.length ? (
            <ResponsiveDataTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>客户</TableHead>
                    <TableHead>拿货单 / 平台单号</TableHead>
                    <TableHead>创建时间 / 账龄</TableHead>
                    <TableHead className="text-right">待退款</TableHead>
                    <TableHead className="text-right">处理</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingRefunds.map((refund) => (
                    <TableRow key={refund.shipmentId}>
                      <TableCell>
                        <p className="font-medium">{refund.customerCode}</p>
                        <p className="text-xs text-muted">{refund.customerName}</p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{refund.orderNumber}</p>
                        <p className="text-xs text-muted">{refund.externalOrderNo}</p>
                      </TableCell>
                      <TableCell>
                        <p>{dateTime(refund.createdAt)}</p>
                        <p className="text-xs text-warning">{refundAge(refund.createdAt)}</p>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-danger">
                        {money(refund.offlineAmountFen)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link className="font-medium text-primary hover:underline" href={`/admin/orders/${refund.orderId}`}>
                          进入订单详情处理
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ResponsiveDataTable>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-muted" role="status">
              暂无线下退款待办。
            </div>
          )}
        </SettlementRegion>

        <SettlementRegion
          description="批量拿货会合并为一次付款；这里核对余额抵扣、微信待付与审计记录。"
          kind="batches"
          title="批量付款记录"
          contentClassName="grid gap-0 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0"
        >
          <Link className="flex min-h-24 items-center justify-between gap-4 p-4 transition-colors hover:bg-surface sm:p-5" href="/admin/settlement-batches">
            <span>
              <strong className="text-ink">批量付款审核</strong>
              <span className="mt-1 block text-sm text-muted">查看每次合并付款、余额冻结、微信待付与整笔审核。</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">{`待审核 ${pendingBatches.length}`}</Badge>
              <ChevronRight aria-hidden="true" className="size-4 text-primary" />
            </span>
          </Link>
          <Link className="flex min-h-24 items-center justify-between gap-4 p-4 transition-colors hover:bg-surface sm:p-5" href="/admin/bulk-orders">
            <span>
              <strong className="text-ink">批量草稿诊断</strong>
              <span className="mt-1 block text-sm text-muted">只读查看文件摘要、冲突和部分提交结果。</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-primary" />
          </Link>
        </SettlementRegion>

        <SettlementRegion
          description="先查看客户当前余额；只有超级管理员可展开并执行人工调整。"
          kind="balances"
        >
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

          {principal.kind === "SUPER_ADMIN" ? (
            <details aria-label="调整客户余额（超级管理员）" className="group border-t border-border">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 transition-colors hover:bg-surface-muted/60 sm:px-5 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-3">
                  <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-warning" />
                  <span>
                    <strong className="block text-sm text-ink">调整客户余额（超级管理员）</strong>
                    <span className="mt-0.5 block text-xs text-muted">高风险操作：展开后核对客户、方向、金额和审计原因。</span>
                  </span>
                </span>
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <ConfirmedActionForm
                action={adjustWalletAction}
                className="grid gap-4 border-t border-border bg-warning/5 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-[1.1fr_0.8fr_0.8fr_1.6fr_auto] xl:items-end"
                confirmDescription="请返回核对客户、增加或扣减方向、金额和原因。确认后会立即改变客户可用余额并写入不可变资金流水。"
                confirmLabel="确认执行余额调整"
                confirmTitle="确认执行余额调整？"
                submitLabel="核对并调整余额"
                variant="default"
              >
                <input name="requestId" type="hidden" value={randomUUID()} />
                <label className="space-y-2 text-sm font-medium text-ink">
                  客户
                  <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="customerId" required>
                    <option value="">选择客户</option>
                    {accounts.map((account) => (
                      <option key={account.customerId} value={account.customerId}>{`${account.customerCode} · ${account.customerName}`}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm font-medium text-ink">
                  操作
                  <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="operation" required>
                    <option value="">选择增加或扣减</option>
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
                  <Input className="min-h-11" maxLength={300} name="reason" placeholder="例如：收到微信转账" required />
                </label>
              </ConfirmedActionForm>
            </details>
          ) : (
            <div className="border-t border-border bg-surface-muted/55 px-4 py-3 text-sm text-muted sm:px-5">
              <p className="font-medium text-ink">余额调整仅限超级管理员操作</p>
              <p className="mt-1">普通管理员可查看客户余额和资金流水，但不能创建或扣减现金等价余额。</p>
            </div>
          )}
        </SettlementRegion>

        <SettlementRegion description="按时间倒序展示最近 100 条，每笔记录均不可修改。" kind="transactions">
          {transactions.length ? (
            <details aria-label="查看资金流水" className="group">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 transition-colors hover:bg-surface-muted/60 sm:px-5 [&::-webkit-details-marker]:hidden">
                <span>
                  <strong className="block text-sm text-ink">查看最近资金流水（{transactions.length}）</strong>
                  <span className="mt-0.5 block text-xs text-muted">默认收起，展开后可核对时间、原因与变动后余额。</span>
                </span>
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border">
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
                      {transactions.map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell className="text-muted">{dateTime(transaction.createdAt)}</TableCell>
                          <TableCell><p className="font-medium">{transaction.customerCode}</p><p className="text-xs text-muted">{transaction.customerName}</p></TableCell>
                          <TableCell>
                            {transaction.deltaFen > 0 ? (
                              <span className="inline-flex items-center gap-1 text-success"><ArrowDownLeft aria-hidden="true" className="size-4" />入账</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-danger"><ArrowUpRight aria-hidden="true" className="size-4" />扣款</span>
                            )}
                          </TableCell>
                          <TableCell><p>{transaction.reason}</p>{transaction.orderNumber ? <p className="mt-1 text-xs text-muted">{transaction.orderNumber}</p> : null}</TableCell>
                          <TableCell className={`text-right font-semibold tabular-nums ${transaction.deltaFen > 0 ? "text-success" : "text-danger"}`}>
                            {transaction.deltaFen > 0 ? "+" : "−"}{money(Math.abs(transaction.deltaFen))}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{money(transaction.afterBalanceFen)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ResponsiveDataTable>
              </div>
            </details>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-muted" role="status">暂无资金流水。</div>
          )}
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
