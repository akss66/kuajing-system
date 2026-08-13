import { ArrowDownLeft, ArrowUpRight, LockKeyhole, WalletCards } from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
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
        description="余额足够时提交拿货单会自动扣款；充值仍通过线下微信联系管理员。"
        title="余额与流水"
      />

      <SettlementWorkspace>
        <SettlementRegion
          contentClassName="grid grid-cols-2 divide-x divide-y divide-border md:grid-cols-4 md:divide-y-0"
          description="先确认可用余额，再查看冻结批次与每一笔资金变化。"
          kind="balances"
        >
          {[
            { hint: "客户账户账面余额", label: "账面余额", value: money(wallet.balanceFen) },
            { hint: "统一结算暂时冻结的金额", label: "已冻结", value: money(wallet.activeHoldFen) },
            { hint: "当前可直接用于下单", label: "可用余额", value: money(wallet.availableFen) },
            { hint: "最近冻结批次与流水都在下方", label: "流水条数", value: String(wallet.transactions.length) },
          ].map((item) => (
            <div className="min-w-0 px-4 py-4 sm:px-5" key={item.label}>
              <p className="text-xs font-medium text-muted">{item.label}</p>
              <p className="mt-1 truncate text-lg font-semibold tabular-nums text-ink">{item.value}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{item.hint}</p>
            </div>
          ))}
        </SettlementRegion>

        <SettlementRegion
          action={<LockKeyhole aria-hidden="true" className="size-5 text-primary" />}
          description="统一付款时会先冻结钱包抵扣金额，结算完成或关闭后自动释放或消耗。"
          kind="batches"
          title="冻结批次"
        >

        {wallet.holds.length ? (
          <div className="divide-y divide-border">
            {wallet.holds.map((hold) => (
              <article className="p-4 sm:px-5" key={hold.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink">批次 {hold.batchNumber}</p>
                      <Badge variant="secondary">{hold.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">冻结于 {dateTime(hold.createdAt)}（渥太华）</p>
                    {hold.releasedAt ? <p className="mt-1 text-xs text-muted">处理于 {dateTime(hold.releasedAt)}（渥太华）</p> : null}
                    {hold.releaseReason ? <p className="mt-1 text-xs text-muted">{hold.releaseReason}</p> : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="font-semibold tabular-nums text-ink">{money(hold.amountFen)}</p>
                    <Link className="text-sm font-medium text-primary-hover" href={`/portal/settlements/${hold.settlementBatchId}`}>
                      查看结算
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="px-5 py-14 text-center">
            <p className="font-medium text-ink">暂无冻结记录</p>
            <p className="mt-1 text-sm text-muted">提交统一付款后会在这里记录冻结历史。</p>
          </div>
        )}
        </SettlementRegion>

        <SettlementRegion
          action={<WalletCards aria-hidden="true" className="size-5 text-primary" />}
          description="每笔资金变化均不可修改，并关联对应拿货单。"
          kind="transactions"
        >

        {wallet.transactions.length ? (
          <div className="divide-y divide-border">
            {wallet.transactions.map((transaction) => (
              <article className="flex items-start gap-3 p-4 sm:px-5" key={transaction.id}>
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
          <div className="px-5 py-16 text-center">
            <p className="font-medium text-ink">暂无资金流水</p>
            <p className="mt-1 text-sm text-muted">管理员充值或订单扣款后会显示在这里。</p>
          </div>
        )}
        </SettlementRegion>
      </SettlementWorkspace>
    </div>
  );
}
