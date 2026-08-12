import { desc, eq } from "drizzle-orm";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db/client";
import { customers, products, skus, stores } from "@/db/schema";
import {
  createSkuAction,
  createSkuAliasAction,
  setCustomerPriceAction,
} from "@/modules/catalog/actions";

export default async function CatalogPage() {
  const rows = await db
    .select({
      id: skus.id,
      name: skus.name,
      price: skus.defaultUnitPriceFen,
      productName: products.name,
      saleStatus: skus.saleStatus,
      skuCode: skus.skuCode,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .orderBy(desc(skus.createdAt));

  const customerRows = await db
    .select({ code: customers.code, id: customers.id })
    .from(customers)
    .orderBy(customers.code);

  const storeRows = await db
    .select({ id: stores.id, name: stores.name })
    .from(stores)
    .orderBy(stores.name);

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "商品与 SKU" },
        ]}
        description="维护客户可选择的标准 SKU、统一拿货价和店铺别名。"
        title="商品与 SKU"
      />

      <MetricStrip
        items={[
          { label: "SKU 数", value: `${rows.length}` },
          { label: "客户数", value: `${customerRows.length}` },
          { label: "店铺数", value: `${storeRows.length}` },
          { label: "可售 SKU", value: `${rows.filter((row) => row.saleStatus === "SELLABLE").length}` },
        ]}
      />

      <ActionForm
        action={createSkuAction}
        className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 xl:grid-cols-[1fr_1.4fr_1fr_1fr_auto] xl:items-end xl:p-5"
        submitLabel="创建 SKU"
      >
        <label className="space-y-2 text-sm font-medium text-ink">
          标准 SKU
          <Input className="min-h-11" maxLength={80} name="skuCode" placeholder="TZX-001-1" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          商品名称
          <Input className="min-h-11" maxLength={200} name="productName" placeholder="商品通用名称" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          规格名称
          <Input className="min-h-11" maxLength={200} name="skuName" placeholder="颜色 / 规格" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          统一拿货价（元）
          <Input className="min-h-11 tabular-nums" inputMode="decimal" name="defaultPriceYuan" placeholder="6.90" required />
        </label>
      </ActionForm>

      <div className="grid gap-4 xl:grid-cols-2">
        <ActionForm
          action={setCustomerPriceAction}
          className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
          submitLabel="保存专属价"
        >
          <label className="space-y-2 text-sm font-medium text-ink">
            专属价客户
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="customerId" required>
              <option value="">选择客户</option>
              {customerRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            专属价 SKU
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="skuId" required>
              <option value="">选择 SKU</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.skuCode}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            客户价（元）
            <Input className="min-h-11" name="unitPriceYuan" placeholder="7.60" required />
          </label>
        </ActionForm>

        <ActionForm
          action={createSkuAliasAction}
          className="grid gap-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
          submitLabel="保存 SKU 映射"
        >
          <label className="space-y-2 text-sm font-medium text-ink">
            别名店铺
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="storeId" required>
              <option value="">选择店铺</option>
              {storeRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            映射标准 SKU
            <select className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" name="aliasSkuId" required>
              <option value="">选择 SKU</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.skuCode}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            店铺导出 SKU
            <Input className="min-h-11" name="externalSku" placeholder="TEMU-RED-01" required />
          </label>
        </ActionForm>
      </div>

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <DataWorkspaceToolbar
          description="订单导入只匹配管理员预先维护的标准 SKU。"
          title="SKU 货盘"
        />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>商品</TableHead>
                <TableHead>规格名称</TableHead>
                <TableHead className="text-right">统一拿货价</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-semibold">{row.skuCode}</TableCell>
                    <TableCell>{row.productName}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">¥{(row.price / 100).toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge
                        className={row.saleStatus === "SELLABLE" ? "bg-success/10 text-success" : "bg-surface-muted text-muted"}
                        variant="secondary"
                      >
                        {row.saleStatus === "SELLABLE" ? "可售" : "不可售"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-28 text-center text-muted" colSpan={5}>
                    暂无 SKU，添加商品后会显示在这里。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </section>
    </div>
  );
}
