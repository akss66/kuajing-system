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
  blockedCount,
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
  blockedCount: number;
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

  const continuousMetrics = [
    { label: "店铺", value: `${selectedCount}` },
    { label: "订单", value: `${orderCount}` },
    { label: "件数", value: `${quantity}` },
    { label: "金额", value: money(totalAmountFen) },
    { label: "不可提交", value: `${blockedCount}` },
  ];
  const expandedMetrics = [
    { label: "文件 / 订单", value: `${fileCount} / ${orderCount}` },
    { label: "账户余额 / 冻结", value: `${money(balanceFen)} / ${money(activeHoldFen)}` },
    { label: "可用余额 / 微信待付", value: `${money(availableFen)} / ${money(wechatDueFen)}` },
  ];

  return (
    <section
      aria-label="批次摘要"
      className="sticky bottom-[calc(var(--merchant-mobile-dock-height)+env(safe-area-inset-bottom)+0.5rem)] z-20 rounded-[var(--radius-surface)] border border-border bg-background px-3 py-1 shadow-[0_-8px_24px_oklch(0.22_0.018_175/0.08)] sm:px-5 sm:py-4 lg:bottom-4 xl:py-2"
      data-testid="bulk-order-summary"
    >
      <span className="sr-only">{`已选 ${selectedCount} 个店铺`}</span>
      <div className="sm:hidden">
        <dl className="grid grid-cols-5 gap-1" aria-label="持续批次指标">
          {continuousMetrics.map((item) => (
            <div className="min-w-0 text-center" key={item.label}>
              <dt className="truncate text-[0.65rem] text-muted">{item.label}</dt>
              <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-1 flex items-center justify-end gap-2">
          <Button
            className="min-h-11 px-3"
            onClick={() => setMobileExpanded((current) => !current)}
            type="button"
            variant="outline"
          >
            {mobileExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
            {mobileExpanded ? "收起汇总" : "查看汇总"}
          </Button>
          <Button className="min-h-11 px-4" disabled={submitDisabled} type="submit">
            {submitting ? "提交中" : "提交拿货单"}
          </Button>
        </div>

        {mobileExpanded ? (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <div className="grid gap-2">
              {expandedMetrics.map((item) => (
                <div className="rounded-lg bg-surface px-3 py-2" key={item.label}>
                  <p className="text-xs text-muted">{item.label}</p>
                  <p className="mt-1 font-semibold tabular-nums text-ink">{item.value}</p>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <WalletCards className="size-4 text-primary" />
                余额抵扣与合并付款
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
          {continuousMetrics.map((item) => (
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
              {submitting ? "提交中" : "提交拿货单并付款"}
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
          <dl className="grid grid-cols-5 gap-2">
            {continuousMetrics.map((item) => (
              <div className="min-w-0" key={item.label}>
                <dt className="truncate text-xs text-muted">{item.label}</dt>
                <dd className="mt-1 truncate font-semibold tabular-nums text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
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
              {submitting ? "提交中" : "提交拿货单并付款"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
