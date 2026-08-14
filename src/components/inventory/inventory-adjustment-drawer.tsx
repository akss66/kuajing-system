"use client";

import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_MANUAL_INVENTORY_REASON,
  inventoryReasonLabel,
  MANUAL_INVENTORY_REASON_CODES,
  type InventoryAdjustmentDirection,
  type ManualInventoryReasonCode,
} from "@/modules/inventory/types";
import type { ManagedAction } from "@/shared/action-state";

import { InventoryAdjustmentPreview } from "./inventory-adjustment-preview";
import type { InventoryWorkspaceRow } from "./inventory-workspace";

const offlineWarning =
  "仅用于未经过本系统订单的线下发货或历史补录；系统订单确认发货后会自动扣减，请勿重复调整。";

export function InventoryAdjustmentDrawer({
  action,
  row,
  setActualAction,
}: {
  action: ManagedAction;
  row: InventoryWorkspaceRow;
  setActualAction: ManagedAction;
}) {
  const [mode, setMode] = useState<"ADJUST" | "STOCKTAKE">("ADJUST");
  const [direction, setDirection] = useState<InventoryAdjustmentDirection>("INCREASE");
  const [quantityValue, setQuantityValue] = useState("");
  const [actualValue, setActualValue] = useState("");
  const [reasonCode, setReasonCode] = useState<ManualInventoryReasonCode>(
    DEFAULT_MANUAL_INVENTORY_REASON.INCREASE,
  );
  const quantity = Number(quantityValue);
  const validQuantity = Number.isSafeInteger(quantity) && quantity > 0;
  const delta = validQuantity ? (direction === "INCREASE" ? quantity : -quantity) : 0;
  const afterTotal = row.total + delta;
  const belowLocked = validQuantity && afterTotal < row.locked;
  const actualTotal = Number(actualValue);
  const validActual = Number.isSafeInteger(actualTotal) && actualTotal >= 0;
  const stocktakeDelta = validActual ? actualTotal - row.total : 0;
  const stocktakeBelowLocked = validActual && actualTotal < row.locked;
  const noChange = validActual && actualTotal === row.total;
  const options = useMemo(
    () => MANUAL_INVENTORY_REASON_CODES[direction],
    [direction],
  );

  function selectDirection(nextDirection: InventoryAdjustmentDirection) {
    setDirection(nextDirection);
    setReasonCode(DEFAULT_MANUAL_INVENTORY_REASON[nextDirection]);
  }

  return (
    <EntityDrawer
      description="调整仅作用于当前 SKU；服务端会再次核对订单锁定并记录完整审计流水。"
      size="lg"
      title={`${row.skuCode} 调整库存`}
      trigger={
        <Button
          aria-label={`+ / - 调整 ${row.skuCode}`}
          className="min-h-11 w-full sm:w-auto"
          size="sm"
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" />
          + / - 调整
        </Button>
      }
    >
      <DrawerSection
        description={`当前总库存 ${row.total}，订单锁定 ${row.locked}，可售 ${row.available}。`}
        title="库存调整"
      >
        {mode === "ADJUST" ? (
          <ActionForm
            action={action}
            className="grid gap-4"
            submitDisabled={!validQuantity || belowLocked}
            submitLabel="确认调整库存"
          >
            <input name="skuId" type="hidden" value={row.id} />
            <fieldset>
              <legend className="text-sm font-medium text-foreground">调整方向</legend>
              <div className="mt-2 grid grid-cols-2 rounded-[var(--radius-control)] bg-surface-muted p-1">
                {(["INCREASE", "DECREASE"] as const).map((value) => (
                  <label className="relative" key={value}>
                    <input
                      checked={direction === value}
                      className="peer sr-only"
                      name="direction"
                      onChange={() => selectDirection(value)}
                      type="radio"
                      value={value}
                    />
                    <span className="flex min-h-11 cursor-pointer items-center justify-center rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium text-muted-foreground peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-3 peer-focus-visible:ring-ring/18">
                      {value === "INCREASE" ? "增加" : "减少"}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              调整数量
              <Input
                className="min-h-11 tabular-nums"
                inputMode="numeric"
                min={1}
                name="quantity"
                onChange={(event) => setQuantityValue(event.target.value)}
                placeholder="请输入正整数"
                required
                step={1}
                type="number"
                value={quantityValue}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              调整原因
              <select
                className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground"
                name="reasonCode"
                onChange={(event) => setReasonCode(event.target.value as ManualInventoryReasonCode)}
                value={reasonCode}
              >
                {options.map((code) => (
                  <option key={code} value={code}>{inventoryReasonLabel(code, direction)}</option>
                ))}
              </select>
            </label>
            {reasonCode === "OFFLINE_FULFILLMENT" ? (
              <p className="rounded-[var(--radius-control)] bg-warning/10 px-3 py-2 text-sm text-warning" role="note">
                {offlineWarning}
              </p>
            ) : null}
            <label className="grid gap-2 text-sm font-medium text-foreground">
              备注（可选）
              <textarea className="min-h-24 resize-y rounded-[var(--radius-control)] border border-input bg-background px-3 py-2 text-sm" maxLength={1000} name="remark" placeholder="补充批次、线下单据或盘点说明" />
            </label>
            <InventoryAdjustmentPreview afterTotal={afterTotal} beforeTotal={row.total} currentAvailable={row.available} delta={delta} locked={row.locked} />
            {belowLocked ? (
              <p className="text-sm text-danger" role="alert">调整后总库存不能低于订单锁定 {row.locked}。</p>
            ) : null}
          </ActionForm>
        ) : (
          <ActionForm
            action={setActualAction}
            className="grid gap-4"
            submitDisabled={!validActual || stocktakeBelowLocked || noChange}
            submitLabel="确认盘点结果"
          >
            <input name="skuId" type="hidden" value={row.id} />
            <input name="reasonCode" type="hidden" value="STOCKTAKE_CORRECTION" />
            <label className="grid gap-2 text-sm font-medium text-foreground">
              盘点后实际总库存
              <Input className="min-h-11 tabular-nums" inputMode="numeric" min={0} name="actualTotalQuantity" onChange={(event) => setActualValue(event.target.value)} required step={1} type="number" value={actualValue} />
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              盘点备注（可选）
              <textarea className="min-h-24 resize-y rounded-[var(--radius-control)] border border-input bg-background px-3 py-2 text-sm" maxLength={1000} name="remark" placeholder="填写盘点批次或差异说明" />
            </label>
            <InventoryAdjustmentPreview afterTotal={validActual ? actualTotal : row.total} beforeTotal={row.total} currentAvailable={row.available} delta={stocktakeDelta} locked={row.locked} />
            {noChange ? <p className="text-sm text-muted-foreground" role="status">无变化，不生成库存流水。</p> : null}
            {stocktakeBelowLocked ? <p className="text-sm text-danger" role="alert">实际总库存不能低于订单锁定 {row.locked}。</p> : null}
          </ActionForm>
        )}
        <Button className="min-h-11 w-full" onClick={() => setMode(mode === "ADJUST" ? "STOCKTAKE" : "ADJUST")} type="button" variant="ghost">
          {mode === "ADJUST" ? "设置为实际库存" : "返回 + / - 调整"}
        </Button>
      </DrawerSection>
    </EntityDrawer>
  );
}
