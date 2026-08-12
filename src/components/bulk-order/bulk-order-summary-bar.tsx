"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, WalletCards } from "lucide-react";

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
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const metrics = [
    { label: "已选店铺", value: `${selectedCount} 个店铺` },
    { label: "文件 / 订单", value: `${fileCount} / ${orderCount}` },
    { label: "件数 / 总额", value: `${quantity} 件 / ${money(totalAmountFen)}` },
    { label: "账户余额 / 冻结", value: `${money(balanceFen)} / ${money(activeHoldFen)}` },
    { label: "可用余额 / 微信待付", value: `${money(availableFen)} / ${money(wechatDueFen)}` },
  ];

  return (
    <section
      className="sticky bottom-0 z-20 rounded-t-[var(--radius-surface)] border border-border bg-background/98 px-4 py-2 shadow-[0_-8px_24px_oklch(0.22_0.018_175/0.08)] backdrop-blur-sm sm:bottom-4 sm:rounded-[var(--radius-surface)] sm:px-5 sm:py-4 xl:py-2"
      data-testid="bulk-order-summary"
    >
      <div className="sm:hidden">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">{`已选 ${selectedCount} 个店铺`}</p>
          </div>
          <Button
            className="min-h-11 px-3"
            onClick={() => setMobileExpanded((current) => !current)}
            type="button"
            variant="outline"
          >
            {mobileExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
            {mobileExpanded ? "收起" : "查看汇总"}
          </Button>
          <Button className="min-h-11 px-4" disabled={submitDisabled} type="submit">
            {submitting ? "提交中" : "提交拿货单"}
          </Button>
        </div>

        {mobileExpanded ? (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="grid gap-2">
              {metrics.map((item) => (
                <div className="rounded-lg bg-surface px-3 py-2" key={item.label}>
                  <p className="text-xs text-muted">{item.label}</p>
                  <p className="mt-1 font-semibold tabular-nums text-ink">{item.value}</p>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <WalletCards className="size-4 text-primary" />
                余额抵扣与统一付款
              </div>
              <label className="mt-3 block space-y-2 text-sm font-medium text-ink">
                本次使用钱包抵扣（元）
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
              <div className="mt-3 space-y-1 text-sm text-muted">
                <p>{`本次实际冻结 ${money(requestedWalletFen)}，剩余通过微信待付。`}</p>
                <p>失败店铺会保留原文件与错误原因，便于继续修复后重提。</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="hidden gap-3 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] xl:items-center">
        <div className="grid gap-2 xl:grid-cols-5">
          {metrics.map((item) => (
            <div className="rounded-lg bg-surface px-3 py-2 xl:py-1" key={item.label}>
              <p className="text-xs text-muted">{item.label}</p>
              <p className="mt-0.5 font-semibold tabular-nums text-ink">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-surface px-3 py-2 xl:py-1">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="grid gap-1 text-xs font-medium text-ink">
              本次使用钱包抵扣（元）
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
              {submitting ? "提交中" : "提交拿货单并进入结算"}
            </Button>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <WalletCards className="size-3.5 shrink-0 text-primary" />
            <p>{`实际冻结 ${money(requestedWalletFen)}，剩余微信待付。`}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 hidden sm:block xl:hidden">
        <div className="grid gap-3 rounded-lg border border-border bg-surface px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted">已选店铺</p>
              <p className="mt-1 font-semibold text-ink">{`${selectedCount} 个店铺`}</p>
            </div>
            <div>
              <p className="text-xs text-muted">订单 / 件数</p>
              <p className="mt-1 font-semibold text-ink">{`${orderCount} / ${quantity}`}</p>
            </div>
            <div>
              <p className="text-xs text-muted">微信待付</p>
              <p className="mt-1 font-semibold text-ink">{money(wechatDueFen)}</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="space-y-2 text-sm font-medium text-ink">
              本次使用钱包抵扣（元）
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
              {submitting ? "提交中" : "提交拿货单并进入结算"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
