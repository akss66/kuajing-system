"use client";

import { Layers3, Link2, Plus, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";

import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ManagedAction } from "@/shared/action-state";

import type { CatalogProductOption, CatalogRow, CatalogWorkspaceProps } from "./catalog-workspace";

const selectClassName =
  "min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18";

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return <label className="grid min-w-0 gap-2 text-sm font-medium text-foreground">{label}{children}</label>;
}

export function CreateSkuDrawer({
  action,
  products,
}: {
  action: ManagedAction;
  products: CatalogProductOption[];
}) {
  const [mode, setMode] = useState<"CREATE" | "EXISTING">("EXISTING");
  return (
    <EntityDrawer description="完整录入商品、SKU 与初始库存；同一商品可以继续添加多个 SKU。" size="lg" title="新建 SKU" trigger={<Button className="min-h-11 w-full !bg-primary-hover sm:w-auto" type="button"><Plus aria-hidden="true" />新建 SKU</Button>}>
      <ActionForm action={action} className="grid gap-6" submitClassName="bg-primary-hover" submitLabel="创建 SKU">
        <DrawerSection description="选择已有商品可复用序号、名称和链接文字；货品价格由每个 SKU 独立维护。" title="所属商品">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="创建方式">
              <select className={selectClassName} name="productMode" onChange={(event) => setMode(event.target.value as typeof mode)} value={mode}>
                <option value="EXISTING">添加到已有商品</option><option value="CREATE">创建新商品</option>
              </select>
            </Field>
            {mode === "EXISTING" ? (
              <Field label="商品"><select className={selectClassName} name="productId" required><option value="">选择商品</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sourceSequence ?? "—"} · {product.name}</option>)}</select></Field>
            ) : (
              <Field label="序号"><Input inputMode="numeric" maxLength={64} name="sourceSequence" placeholder="例如：77" required /></Field>
            )}
            {mode === "CREATE" ? <><Field label="商品名称"><Input maxLength={200} name="productName" required /></Field><Field label="链接文字"><Input maxLength={500} name="linkText" /></Field></> : null}
          </div>
        </DrawerSection>
        <DrawerSection description="采购价仅供内部管理；客户拿货价读取该 SKU 自己的货品价格。" title="SKU 资料">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SKU"><Input maxLength={80} name="skuCode" placeholder="TZX-077-1" required /></Field>
            <Field label="图片"><Input accept="image/jpeg,image/png,image/webp" name="image" type="file" /><span className="text-xs font-normal text-muted-foreground">支持 JPEG、PNG、WebP，最大 8 MiB；创建后会显示在管理端和客户货盘。</span></Field>
            <Field label="采购价（元）"><Input inputMode="decimal" name="defaultPriceYuan" required /></Field>
            <Field label="货品价格（元）"><Input inputMode="decimal" name="cargoPriceYuan" placeholder="8.00" required /></Field>
            <Field label="初始库存（份）"><Input inputMode="numeric" min="0" name="initialStock" required type="number" /></Field>
            <Field label="链接地址"><Input name="productUrl" placeholder="https://" type="url" /></Field>
            <Field label="规格"><Input maxLength={240} name="specification" /></Field>
            <Field label="颜色"><Input maxLength={160} name="color" /></Field>
            <Field label="组合销售"><Input maxLength={160} name="combination" /></Field>
            <Field label="重量（克）"><Input inputMode="numeric" min="0" name="weightGrams" required type="number" /></Field>
            <Field label="销售状态"><select className={selectClassName} defaultValue="SELLABLE" name="saleStatus"><option value="SELLABLE">可售</option><option value="NOT_SELLABLE">不可售</option></select></Field>
          </div>
        </DrawerSection>
        <DrawerSection title="审计"><Field label="创建原因"><Input maxLength={500} name="reason" placeholder="例如：新增货盘序号 77" required /></Field></DrawerSection>
      </ActionForm>
    </EntityDrawer>
  );
}

export function ManageSkuDrawer({ actions, groupSize, row }: { actions: Pick<CatalogWorkspaceProps["actions"], "deleteSku" | "restoreSku" | "updateProduct" | "updateSku">; groupSize: number; row: CatalogRow }) {
  if (row.lifecycleStatus === "ARCHIVED") {
    return (
      <EntityDrawer description={`${row.skuCode} 已从新业务中隐藏，可审计恢复。`} title={`管理 ${row.skuCode}`} trigger={<Button className="min-h-11" size="sm" type="button" variant="outline"><Settings2 aria-hidden="true" />管理</Button>}>
        <DrawerSection description="恢复后默认保持不可售，必须核对商品资料和库存后再手动启用销售。" title="恢复已归档 SKU">
          <p className="rounded-[var(--radius-control)] bg-muted p-3 text-sm text-muted-foreground">归档原因：{row.archiveReason ?? "未记录"}</p>
          <ActionForm action={actions.restoreSku} className="grid gap-4" submitLabel="恢复 SKU">
            <input name="skuId" type="hidden" value={row.id} />
            <Field label="恢复原因"><Input maxLength={500} name="reason" required /></Field>
          </ActionForm>
        </DrawerSection>
      </EntityDrawer>
    );
  }
  return (
    <EntityDrawer description={`分别维护共享商品资料与 ${row.skuCode} 的独立资料。`} size="lg" title={`管理 ${row.skuCode}`} trigger={<Button className="min-h-11" size="sm" type="button" variant="outline"><Settings2 aria-hidden="true" />管理</Button>}>
      <DrawerSection description={`修改后会影响该商品下 ${groupSize} 个 SKU 的序号、商品名称和链接文字。`} title="商品资料（同组共享）">
        <ActionForm action={actions.updateProduct} className="grid gap-4 sm:grid-cols-2" submitLabel="保存商品资料">
          <input name="productId" type="hidden" value={row.productId} />
          <Field label="序号"><Input defaultValue={row.sourceSequence ?? ""} name="sourceSequence" required /></Field>
          <Field label="商品名称"><Input defaultValue={row.productName} name="productName" required /></Field>
          <Field label="链接文字"><Input defaultValue={row.linkText ?? ""} name="linkText" /></Field>
          <Field label="修改原因"><Input name="reason" required /></Field>
        </ActionForm>
      </DrawerSection>
      <DrawerSection title="SKU 资料">
        <ActionForm action={actions.updateSku} className="grid gap-4 sm:grid-cols-2" submitLabel="保存 SKU 资料">
          <input name="skuId" type="hidden" value={row.id} />
          <Field label="SKU"><Input defaultValue={row.skuCode} name="skuCode" required /></Field>
          <Field label="替换图片"><Input accept="image/jpeg,image/png,image/webp" name="image" type="file" /><span className="text-xs font-normal text-muted-foreground">留空则保留现有图片；支持 JPEG、PNG、WebP，最大 8 MiB。</span></Field>
          <Field label="采购价（元）"><Input defaultValue={String(row.defaultUnitPriceMilliYuan / 1000)} inputMode="decimal" name="defaultPriceYuan" required /></Field>
          <Field label="货品价格（元）"><Input defaultValue={row.cargoUnitPriceMilliYuan === null ? "" : String(row.cargoUnitPriceMilliYuan / 1000)} inputMode="decimal" name="cargoPriceYuan" required /></Field>
          <Field label="链接地址"><Input defaultValue={row.productUrl ?? ""} name="productUrl" type="url" /></Field>
          <Field label="规格"><Input defaultValue={row.specification ?? ""} name="specification" /></Field>
          <Field label="颜色"><Input defaultValue={row.color ?? ""} name="color" /></Field>
          <Field label="组合销售"><Input defaultValue={row.combination ?? ""} name="combination" /></Field>
          <Field label="重量（克）"><Input defaultValue={row.weightGrams ?? 0} min="0" name="weightGrams" required type="number" /></Field>
          <Field label="销售状态"><select className={selectClassName} defaultValue={row.saleStatus} name="saleStatus"><option value="SELLABLE">可售</option><option value="NOT_SELLABLE">不可售</option></select></Field>
          <Field label="修改原因"><Input name="reason" required /></Field>
        </ActionForm>
      </DrawerSection>
      <DrawerSection description="有业务历史时会安全归档；无引用且库存为 0 时物理删除。" title="危险操作">
        <ActionForm action={actions.deleteSku} className="grid gap-4" submitClassName="bg-destructive text-destructive-foreground" submitLabel="确认删除 SKU">
          <input name="skuId" type="hidden" value={row.id} />
          <Field label="删除原因"><Input name="reason" required /></Field>
          <p className="text-sm text-muted-foreground">删除前请确认：{row.productName} / {row.skuCode}。</p>
        </ActionForm>
      </DrawerSection>
    </EntityDrawer>
  );
}

export function BatchSkuDrawer({ action, products, selectedIds }: { action: ManagedAction; products: CatalogProductOption[]; selectedIds: string[] }) {
  const [mode, setMode] = useState("SET_STATUS");
  return <EntityDrawer description={`当前选择 ${selectedIds.length} 个 SKU；一次最多处理 100 个，失败时整批回滚。`} title="批量管理 SKU" trigger={<Button className="min-h-11" disabled={selectedIds.length === 0} type="button" variant="outline"><Layers3 aria-hidden="true" />批量管理 SKU{selectedIds.length ? ` (${selectedIds.length})` : ""}</Button>}>
    <ActionForm action={action} className="grid gap-4" submitLabel="确认批量操作">
      {selectedIds.map((id) => <input key={id} name="skuIds" type="hidden" value={id} />)}
      <Field label="批量操作"><select className={selectClassName} name="mode" onChange={(event) => setMode(event.target.value)} value={mode}><option value="SET_STATUS">修改销售状态</option><option value="MOVE">移动到其他商品</option><option value="DELETE">删除 SKU</option></select></Field>
      {mode === "SET_STATUS" ? <Field label="销售状态"><select className={selectClassName} name="saleStatus"><option value="SELLABLE">可售</option><option value="NOT_SELLABLE">不可售</option></select></Field> : null}
      {mode === "MOVE" ? <Field label="目标商品"><select className={selectClassName} name="productId" required><option value="">选择商品</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sourceSequence ?? "—"} · {product.name}</option>)}</select></Field> : null}
      {mode === "DELETE" ? <p className="rounded-[var(--radius-control)] bg-destructive/8 p-3 text-sm text-destructive"><Trash2 aria-hidden="true" className="mr-2 inline size-4" />系统将按历史引用自动物理删除或归档。</p> : null}
      <Field label="操作原因"><Input maxLength={500} name="reason" required /></Field>
    </ActionForm>
  </EntityDrawer>;
}

export function AliasDrawer({ action, rows, stores }: { action: ManagedAction; rows: CatalogRow[]; stores: CatalogWorkspaceProps["stores"] }) {
  const disabled = stores.length === 0 || rows.length === 0;
  return <EntityDrawer description="将店铺导出的 SKU 映射到标准 SKU，供订单导入匹配。" title="新增店铺 SKU 映射" trigger={<Button className="min-h-11 w-full" disabled={disabled} type="button" variant="outline"><Link2 aria-hidden="true" />新增 SKU 映射</Button>}>
    <DrawerSection title="店铺映射"><ActionForm action={action} className="grid gap-4" submitClassName="bg-primary-hover" submitLabel="保存 SKU 映射">
      <Field label="别名店铺"><select className={selectClassName} name="storeId" required><option value="">选择店铺</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></Field>
      <Field label="映射标准 SKU"><select className={selectClassName} name="aliasSkuId" required><option value="">选择 SKU</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.skuCode}</option>)}</select></Field>
      <Field label="店铺导出 SKU"><Input maxLength={160} name="externalSku" placeholder="TEMU-RED-01" required /></Field>
    </ActionForm></DrawerSection>
  </EntityDrawer>;
}
