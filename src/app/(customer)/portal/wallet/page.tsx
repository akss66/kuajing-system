import { ArrowDownLeft, ArrowUpRight, LockKeyhole, WalletCards } from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { SettlementRegion, SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { requireCustomer } from "@/modules/identity/guards";
import { getCustomerWalletView } from "@/modules/wallet/queries";
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

export default async function CustomerWalletPage() {
  const principal = await requireCustomer();
  const wallet = await getCustomerWalletView(principal.customerId);

  return (
    <div className="space-y-5">
      <PageHeading
        description="查看可用余额、当前订单占用和最近 100 笔资金变化；充值仍通过线下微信联系管理员。"
        title="资金中心"
      />

      <SettlementWorkspace>
        <SettlementRegion
          contentClassName="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0"
          description="提交订单前可先确认可用余额；所有资金变化都会保留记录。"
          kind="balances"
        >
          {[
            { featured: true, hint: "当前可直接用于下单", label: "可用余额", value: money(wallet.availableFen) },
            { hint: "客户账户账面余额", label: "账面余额", value: money(wallet.balanceFen) },
            { hint: "等待付款确认的订单暂时占用", label: "订单占用", value: money(wallet.activeHoldFen) },
          ].map((item) => (
            <div className={item.featured ? "min-w-0 bg-primary/5 px-4 py-4 sm:px-5" : "min-w-0 px-4 py-4 sm:px-5"} key={item.label}>
              <p className="text-xs font-medium text-muted">{item.label}</p>
              <p className={item.featured ? "mt-1 truncate text-2xl font-semibold tabular-nums text-primary" : "mt-1 truncate text-lg font-semibold tabular-nums text-ink"}>{item.value}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{item.hint}</p>
            </div>
          ))}
        </SettlementRegion>

        <SettlementRegion
          action={<LockKeyhole aria-hidden="true" className="size-5 text-primary" />}
          description="显示最近 50 条订单占用；付款完成或关闭后自动扣除或释放。"
          kind="batches"
          title="订单资金占用"
        >
        {wallet.holds.length ? (
          <div className="grid gap-3 bg-slate-50/50 p-3">
            {wallet.holds.map((hold) => (
              <article className="rounded-xl bg-white p-4 shadow-[0_1px_5px_rgb(15_23_42/0.03)] sm:px-5" key={hold.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink">付款编号 {hold.batchNumber}</p>
                      <Badge variant="secondary">{hold.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">占用于 {dateTime(hold.createdAt)}（渥太华）</p>
                    {hold.releasedAt ? <p className="mt-1 text-xs text-muted">处理于 {dateTime(hold.releasedAt)}（渥太华）</p> : null}
                    {hold.releaseReason ? <p className="mt-1 text-xs text-muted">{hold.releaseReason}</p> : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="font-semibold tabular-nums text-ink">{money(hold.amountFen)}</p>
                    <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary-hover" href={`/portal/settlements/${hold.settlementBatchId}`}>
                      查看付款
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <ActionableEmptyState
            description="使用余额支付或合并付款后，会在这里保留占用记录。"
            kind="initial"
            title="暂无订单资金占用"
          />
        )}
        </SettlementRegion>

        <SettlementRegion
          action={<WalletCards aria-hidden="true" className="size-5 text-primary" />}
          description="显示最近 100 笔资金变化；记录均不可修改，并关联对应拿货单。"
          kind="transactions"
        >
        {wallet.transactions.length ? (
          <div className="grid gap-3 bg-slate-50/50 p-3">
            {wallet.transactions.map((transaction) => (
              <article className="flex items-start gap-3 rounded-xl bg-white p-4 shadow-[0_1px_5px_rgb(15_23_42/0.03)] sm:px-5" key={transaction.id}>
                <span
                  className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg ${
                    transaction.deltaFen > 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
                  }`}
                >
                  {transaction.deltaFen > 0 ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-ink">{transaction.reason}</p>
                      <p className="mt-1 text-xs text-muted">{dateTime(transaction.createdAt)}（渥太华）</p>
                    </div>
                    <p className={`shrink-0 font-semibold tabular-nums ${transaction.deltaFen > 0 ? "text-success" : "text-danger"}`}>
                      {transaction.deltaFen > 0 ? "+" : "−"}
                      {money(Math.abs(transaction.deltaFen))}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-muted">余额 {money(transaction.afterBalanceFen)}</span>
                    {transaction.orderNumber ? <Badge variant="secondary">{transaction.orderNumber}</Badge> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <ActionableEmptyState
            description="管理员充值或订单扣款后会显示在这里。"
            kind="initial"
            title="暂无资金流水"
          />
        )}
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
