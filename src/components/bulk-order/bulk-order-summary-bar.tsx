"use client";

import { WalletCards } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

export function BulkOrderSummaryBar({
  activeHoldFen,
  availableFen,
  balanceFen,
  fileCount,
  onWalletInputChange,
  orderCount,
  quantity,
  requestedWalletFen,
  requestedWalletInput,
  selectedCount,
  submitDisabled,
  submitting,
  totalAmountFen,
  wechatDueFen,
}: {
  activeHoldFen: number;
  availableFen: number;
  balanceFen: number;
  fileCount: number;
  onWalletInputChange: (value: string) => void;
  orderCount: number;
  quantity: number;
  requestedWalletFen: number;
  requestedWalletInput: string;
  selectedCount: number;
  submitDisabled: boolean;
  submitting: boolean;
  totalAmountFen: number;
  wechatDueFen: number;
}) {
  const submitLabel = `提交 ${selectedCount} 个店铺`;

  return (
    <section className="sticky bottom-4 z-10 rounded-[var(--radius-surface)] border border-border bg-background px-4 py-4 shadow-[0_10px_30px_oklch(0.22_0.018_175/0.08)] sm:px-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "店铺", value: `${selectedCount} 个` },
            { label: "文件 / 订单", value: `${fileCount} / ${orderCount}` },
            { label: "件数 / 总额", value: `${quantity} 件 / ${money(totalAmountFen)}` },
            { label: "账面 / 冻结", value: `${money(balanceFen)} / ${money(activeHoldFen)}` },
            { label: "可用 / 微信待付", value: `${money(availableFen)} / ${money(wechatDueFen)}` },
          ].map((item) => (
            <div className="rounded-lg bg-surface px-3 py-3" key={item.label}>
              <p className="text-xs text-muted">{item.label}</p>
              <p className="mt-1 font-semibold tabular-nums text-ink">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-surface px-3 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <WalletCards className="size-4 text-primary" />
            余额与统一付款
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="space-y-2 text-sm font-medium text-ink">
              本次余额抵扣
              <Input
                className="min-h-11 tabular-nums"
                inputMode="decimal"
                min="0"
                onChange={(event) => onWalletInputChange(event.target.value)}
                step="0.01"
                type="number"
                value={requestedWalletInput}
              />
            </label>
            <Button className="min-h-11 px-4" disabled={submitDisabled} type="submit">
              {submitting ? "正在提交" : submitLabel}
            </Button>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-muted">
            <p>本次实际冻结 {money(requestedWalletFen)}，剩余金额统一走微信待付。</p>
            <p>失败店铺会保留文件和错误，成功店铺会并入新的统一付款批次。</p>
          </div>
        </div>
      </div>
    </section>
  );
}
