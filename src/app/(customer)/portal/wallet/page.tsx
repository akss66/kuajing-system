import { ArrowDownLeft, ArrowRight, ArrowUpRight, LockKeyhole, WalletCards } from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { SettlementWorkspace } from "@/components/settlement/settlement-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireCustomer } from "@/modules/identity/guards";
import { getCustomerWalletHoldStatusLabel } from "@/modules/settlement/customer-ui-labels";
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
  const hasActivity = wallet.holds.length > 0 || wallet.transactions.length > 0;

  return (
    <div className="space-y-5">
      <PageHeading
        action={
          <Button asChild className="min-h-11 w-full sm:w-auto" variant="outline">
            <Link href="/portal/settlements">
              查看合并付款记录
              <ArrowRight aria-hidden="true" className="size-4 group-hover/button:translate-x-0.5" />
            </Link>
          </Button>
        }
        description="查看可用余额、当前订单预留和最近 100 笔资金变化；充值仍通过线下微信联系管理员。"
        title="资金中心"
      />

      <SettlementWorkspace>
        <section
          aria-labelledby="wallet-balance-title"
          className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
          data-settlement-region="balances"
        >
          <div className="px-5 pb-3 pt-5 sm:px-6">
            <h2 className="text-base font-semibold text-foreground" id="wallet-balance-title">客户余额</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">提交订单前可先确认可用余额；所有资金变化都会保留记录。</p>
          </div>
          <div className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { featured: true, hint: "当前可直接用于下单", label: "可用余额", value: money(wallet.availableFen) },
              { hint: "客户账户账面余额", label: "账面余额", value: money(wallet.balanceFen) },
              { hint: "等待付款确认时暂时预留", label: "订单预留", value: money(wallet.activeHoldFen) },
            ].map((item) => (
              <div className={item.featured ? "min-w-0 bg-primary/5 px-5 py-4 sm:px-6" : "min-w-0 px-5 py-4 sm:px-6"} key={item.label}>
                <p className="text-xs font-medium text-muted">{item.label}</p>
                <p className={item.featured ? "mt-1 truncate text-2xl font-semibold tabular-nums text-primary" : "mt-1 truncate text-lg font-semibold tabular-nums text-ink"}>{item.value}</p>
                <p className="mt-1 text-xs leading-5 text-muted">{item.hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="wallet-activity-title"
          className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
          data-wallet-activity
        >
          <header className="px-5 pb-4 pt-5 sm:px-6">
            <h2 className="text-base font-semibold text-foreground" id="wallet-activity-title">资金记录</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">集中查看订单资金预留与最近 100 笔余额变化。</p>
          </header>

          {hasActivity ? (
          <div className="grid md:grid-cols-2" data-wallet-activity-groups>
          <section aria-labelledby="wallet-holds-title" className="border-t border-slate-100">
            <div className="flex items-start gap-3 px-5 pb-3 pt-4 sm:px-6">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <LockKeyhole aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground" id="wallet-holds-title">订单预留金额</h3>
                  <Badge variant="secondary">{wallet.holds.length} 笔</Badge>
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">付款完成或订单关闭后，系统会自动扣除或释放预留金额。</p>
              </div>
            </div>
            {wallet.holds.length ? (
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {wallet.holds.map((hold) => (
                  <article className="px-5 py-4 sm:px-6" key={hold.id}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-ink">付款编号 {hold.batchNumber}</p>
                          <Badge variant="secondary">{getCustomerWalletHoldStatusLabel(hold.status)}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted">预留于 {dateTime(hold.createdAt)}（渥太华）</p>
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
              <div className="px-5 pb-5 sm:px-6" role="status">
                <p className="text-sm font-medium text-foreground">当前没有预留中的金额</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">使用余额或提交付款后，这里会显示对应订单。</p>
              </div>
            )}
          </section>

          <section aria-labelledby="wallet-transactions-title" className="border-t border-slate-100 md:border-l">
            <div className="flex items-start gap-3 px-5 pb-3 pt-4 sm:px-6">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <WalletCards aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground" id="wallet-transactions-title">资金流水</h3>
                  <Badge variant="secondary">{wallet.transactions.length} 笔</Badge>
                </div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">记录不可修改；充值、付款、退款与结算变化都会保留。</p>
              </div>
            </div>
            {wallet.transactions.length ? (
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {wallet.transactions.map((transaction) => (
                  <article className="flex items-start gap-3 px-5 py-4 sm:px-6" key={transaction.id}>
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
              <div className="px-5 pb-5 sm:px-6" role="status">
                <p className="text-sm font-medium text-foreground">还没有资金变动</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">充值、付款、退款或订单结算后会显示记录。</p>
              </div>
            )}
          </section>
          </div>
          ) : (
            <div
              aria-label="还没有资金记录"
              className="flex flex-col gap-4 border-t border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6"
              role="status"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <WalletCards aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">还没有资金记录</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">充值、付款、退款或订单结算后，会在这里保留记录。</p>
                </div>
              </div>
              <Link className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-primary-hover" href="/portal/orders">
                查看我的订单
              </Link>
            </div>
          )}
        </section>
      </SettlementWorkspace>
    </div>
  );
}
