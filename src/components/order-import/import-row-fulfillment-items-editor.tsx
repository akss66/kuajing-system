"use client";

import { LoaderCircle, Plus, Save, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type {
  EditableImportRow,
  ImportRowAction,
  ImportRowActionState,
} from "./import-row-model";

const INITIAL_STATE: ImportRowActionState = { status: "idle" };

function ActionMessage({ state }: { state: ImportRowActionState }) {
  if (!state.message) return null;
  return (
    <p
      className={cn(
        "mt-2 text-sm",
        state.status === "error" ? "text-danger" : "text-success",
      )}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

function HiddenRowFields({
  batchId,
  itemId,
  row,
}: {
  batchId: string;
  itemId?: string;
  row: EditableImportRow;
}) {
  return (
    <>
      <input name="batchId" type="hidden" value={batchId} />
      <input name="rowId" type="hidden" value={row.id} />
      <input name="expectedRevision" type="hidden" value={row.revision} />
      {itemId ? <input name="itemId" type="hidden" value={itemId} /> : null}
    </>
  );
}

function ExistingItemEditor({
  batchId,
  item,
  removeAction,
  row,
  updateAction,
}: {
  batchId: string;
  item: EditableImportRow["fulfillmentItems"][number];
  removeAction: ImportRowAction;
  row: EditableImportRow;
  updateAction: ImportRowAction;
}) {
  const router = useRouter();
  const inputId = useId();
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateAction,
    INITIAL_STATE,
  );
  const [removeState, removeFormAction, removePending] = useActionState(
    removeAction,
    INITIAL_STATE,
  );
  useEffect(() => {
    if (updateState.status === "success" || removeState.status === "success") {
      router.refresh();
    }
  }, [removeState.status, router, updateState.status]);

  return (
    <div className="rounded-[var(--radius-control)] border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink">第 {item.position} 个货品</p>
        <span className="text-xs text-muted">
          {item.fulfillmentMode === "SYSTEM_SKU" ? "收货款并扣库存" : "仅收运费"}
        </span>
      </div>
      <form action={updateFormAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
        <HiddenRowFields batchId={batchId} itemId={item.id} row={row} />
        <div>
          <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-sku`}>
            第 {item.position} 个货品 SKU
          </label>
          <Input
            autoComplete="off"
            className="mt-1 min-h-11 text-base sm:text-sm"
            defaultValue={item.skuCode}
            disabled={updatePending || removePending}
            id={`${inputId}-sku`}
            maxLength={160}
            name="skuCode"
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-quantity`}>
            发货数量
          </label>
          <Input
            className="mt-1 min-h-11 text-base tabular-nums sm:text-sm"
            defaultValue={item.effectiveQuantity}
            disabled={updatePending || removePending}
            id={`${inputId}-quantity`}
            max={1_000_000}
            min={1}
            name="effectiveQuantity"
            required
            step={1}
            type="number"
          />
        </div>
        <Button className="min-h-11" disabled={updatePending || removePending} type="submit" variant="outline">
          {updatePending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {updatePending ? "校验中" : "保存"}
        </Button>
      </form>
      <form action={removeFormAction} className="mt-2 flex justify-end">
        <HiddenRowFields batchId={batchId} itemId={item.id} row={row} />
        <Button
          aria-label={`删除第 ${item.position} 个货品`}
          className="min-h-11 text-danger hover:text-danger"
          disabled={updatePending || removePending}
          type="submit"
          variant="ghost"
        >
          {removePending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          删除
        </Button>
      </form>
      <ActionMessage state={updateState.status === "idle" ? removeState : updateState} />
    </div>
  );
}

export function ImportRowFulfillmentItemsEditor({
  addAction,
  batchId,
  removeAction,
  row,
  updateAction,
}: {
  addAction: ImportRowAction;
  batchId: string;
  removeAction: ImportRowAction;
  row: EditableImportRow;
  updateAction: ImportRowAction;
}) {
  const router = useRouter();
  const inputId = useId();
  const [adding, setAdding] = useState(false);
  const [state, formAction, pending] = useActionState(addAction, INITIAL_STATE);
  const additionalItems = row.fulfillmentItems.filter((item) => !item.isPrimary);
  const atLimit = row.fulfillmentItems.length >= 20;

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <section aria-label="附加发货货品" className="space-y-3">
      {additionalItems.map((item) => (
        <ExistingItemEditor
          batchId={batchId}
          item={item}
          key={item.id}
          removeAction={removeAction}
          row={row}
          updateAction={updateAction}
        />
      ))}

      {adding ? (
        <form action={formAction} className="rounded-[var(--radius-control)] border border-dashed border-primary/35 bg-primary/5 p-3">
          <HiddenRowFields batchId={batchId} row={row} />
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
            <div>
              <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-sku`}>
                新增货品 SKU
              </label>
              <Input
                autoComplete="off"
                autoFocus
                className="mt-1 min-h-11 text-base sm:text-sm"
                disabled={pending}
                id={`${inputId}-sku`}
                maxLength={160}
                name="skuCode"
                placeholder="TZX 系统 SKU 或自有货 SKU"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-ink" htmlFor={`${inputId}-quantity`}>
                新增货品数量
              </label>
              <Input
                className="mt-1 min-h-11 text-base tabular-nums sm:text-sm"
                defaultValue={1}
                disabled={pending}
                id={`${inputId}-quantity`}
                max={1_000_000}
                min={1}
                name="effectiveQuantity"
                required
                step={1}
                type="number"
              />
            </div>
            <Button className="min-h-11" disabled={pending} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
              {pending ? "校验中" : "保存新增货品"}
            </Button>
          </div>
          <div className="mt-2 flex justify-end">
            <Button className="min-h-11" disabled={pending} onClick={() => setAdding(false)} type="button" variant="ghost">
              <X />取消
            </Button>
          </div>
          <ActionMessage state={state} />
        </form>
      ) : (
        <Button
          className="min-h-11 w-full border-dashed sm:w-auto"
          disabled={atLimit}
          onClick={() => setAdding(true)}
          type="button"
          variant="outline"
        >
          <Plus />
          {atLimit ? "已达到 20 个货品上限" : "加一个货"}
        </Button>
      )}
      <p className="text-xs leading-5 text-muted">
        TZX 开头的 SKU 会校验价格与库存并收取货款；其他 SKU 仅作为自有货发货，不收商品金额。原 SKU 不会被覆盖。
      </p>
    </section>
  );
}
