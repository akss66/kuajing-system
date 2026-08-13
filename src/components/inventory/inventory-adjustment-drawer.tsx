import { SlidersHorizontal } from "lucide-react";

import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManagedAction } from "@/shared/action-state";

import type { InventoryWorkspaceRow } from "./inventory-workspace";

export function InventoryAdjustmentDrawer({ action, rows }: { action: ManagedAction; rows: InventoryWorkspaceRow[] }) {
  return (
    <EntityDrawer
      description="调整会改变账面总库存，并记录操作前后数量、管理员与审计原因。"
      size="lg"
      title="调整库存"
      trigger={
        <Button className="min-h-11 w-full !bg-primary-hover sm:w-auto" disabled={rows.length === 0} type="button">
          <SlidersHorizontal aria-hidden="true" />
          调整库存
        </Button>
      }
    >
      <DrawerSection description="调整后的总库存不能低于当前订单锁定数量。" title="库存调整">
        <ActionForm action={action} className="grid gap-4" submitClassName="bg-primary-hover" submitLabel="确认调整库存">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            库存 SKU
            <select className="min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18" name="skuId" required>
              <option value="">请选择 SKU</option>
              {rows.map((row) => <option key={row.id} value={row.id}>{row.skuCode}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            调整数量
            <Input className="tabular-nums" inputMode="numeric" name="delta" placeholder="增加填正数，减少填负数" required />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            调整原因
            <Input maxLength={500} name="reason" placeholder="例如：首批入库 / 盘点损耗" required />
          </label>
        </ActionForm>
      </DrawerSection>
    </EntityDrawer>
  );
}
