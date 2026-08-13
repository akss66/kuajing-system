import { BadgeDollarSign, Link2, Plus } from "lucide-react";

import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManagedAction } from "@/shared/action-state";

import type { CatalogRow, CatalogWorkspaceProps } from "./catalog-workspace";

const selectClassName =
  "min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18";

export function CreateSkuDrawer({ action }: { action: ManagedAction }) {
  return (
    <EntityDrawer
      description="创建标准 SKU，并自动初始化为 0 库存。"
      size="lg"
      title="新建 SKU"
      trigger={
        <Button className="min-h-11 w-full !bg-primary-hover sm:w-auto" type="button">
          <Plus aria-hidden="true" />
          新建 SKU
        </Button>
      }
    >
      <DrawerSection description="商品和规格会作为客户货盘中的稳定识别信息。" title="SKU 资料">
        <ActionForm action={action} className="grid gap-4 sm:grid-cols-2" submitClassName="bg-primary-hover" submitLabel="创建 SKU">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            标准 SKU
            <Input maxLength={80} name="skuCode" placeholder="TZX-001-1" required />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            商品名称
            <Input maxLength={200} name="productName" placeholder="商品通用名称" required />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            规格名称
            <Input maxLength={200} name="skuName" placeholder="颜色 / 规格" required />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            统一拿货价（元）
            <Input className="tabular-nums" inputMode="decimal" name="defaultPriceYuan" placeholder="6.90" required />
          </label>
        </ActionForm>
      </DrawerSection>
    </EntityDrawer>
  );
}

export function CustomerPriceDrawer({
  action,
  customers,
  rows,
}: {
  action: ManagedAction;
  customers: CatalogWorkspaceProps["customers"];
  rows: CatalogRow[];
}) {
  const disabled = customers.length === 0 || rows.length === 0;
  return (
    <EntityDrawer
      description="为指定客户设置实际拿货价；未设置时继续使用统一拿货价。"
      title="设置客户专属价"
      trigger={
        <Button className="min-h-11 w-full" disabled={disabled} type="button" variant="outline">
          <BadgeDollarSign aria-hidden="true" />
          设置客户价
        </Button>
      }
    >
      <DrawerSection title="客户与 SKU">
        <ActionForm action={action} className="grid gap-4" submitClassName="bg-primary-hover" submitLabel="保存客户专属价">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            专属价客户
            <select className={selectClassName} name="customerId" required>
              <option value="">选择客户</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.code}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            专属价 SKU
            <select className={selectClassName} name="skuId" required>
              <option value="">选择 SKU</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>{row.skuCode}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            客户价（元）
            <Input className="tabular-nums" inputMode="decimal" name="unitPriceYuan" placeholder="7.60" required />
          </label>
        </ActionForm>
      </DrawerSection>
    </EntityDrawer>
  );
}

export function AliasDrawer({
  action,
  rows,
  stores,
}: {
  action: ManagedAction;
  rows: CatalogRow[];
  stores: CatalogWorkspaceProps["stores"];
}) {
  const disabled = stores.length === 0 || rows.length === 0;
  return (
    <EntityDrawer
      description="将店铺导出的 SKU 映射到标准 SKU，供订单导入匹配。"
      title="新增店铺 SKU 映射"
      trigger={
        <Button className="min-h-11 w-full" disabled={disabled} type="button" variant="outline">
          <Link2 aria-hidden="true" />
          新增 SKU 映射
        </Button>
      }
    >
      <DrawerSection title="店铺映射">
        <ActionForm action={action} className="grid gap-4" submitClassName="bg-primary-hover" submitLabel="保存 SKU 映射">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            别名店铺
            <select className={selectClassName} name="storeId" required>
              <option value="">选择店铺</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>{store.name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            映射标准 SKU
            <select className={selectClassName} name="aliasSkuId" required>
              <option value="">选择 SKU</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>{row.skuCode}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            店铺导出 SKU
            <Input maxLength={160} name="externalSku" placeholder="TEMU-RED-01" required />
          </label>
        </ActionForm>
      </DrawerSection>
    </EntityDrawer>
  );
}
