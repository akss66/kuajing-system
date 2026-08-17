import { CatalogWorkspace } from "@/components/catalog/catalog-workspace";
import { db } from "@/db/client";
import { products, stores } from "@/db/schema";
import {
  batchManageSkusAction,
  createSkuAction,
  createSkuAliasAction,
  deleteSkuAction,
  restoreSkuAction,
  updateProductAction,
  updateSkuAction,
} from "@/modules/catalog/actions";
import { listAdminCatalog } from "@/modules/catalog/admin-catalog";

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lifecycle = params.lifecycle === "archived" ? "ARCHIVED" : "ACTIVE";
  const [rows, productRows, storeRows] = await Promise.all([
    listAdminCatalog({ lifecycle }),
    db.select({
      id: products.id,
      linkText: products.linkText,
      name: products.name,
      sourceSequence: products.sourceSequence,
    }).from(products).orderBy(products.sourceSequence, products.name),
    db
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .orderBy(stores.name),
  ]);

  return (
    <CatalogWorkspace
      actions={{
        batchManage: batchManageSkusAction,
        createAlias: createSkuAliasAction,
        createSku: createSkuAction,
        deleteSku: deleteSkuAction,
        restoreSku: restoreSkuAction,
        updateProduct: updateProductAction,
        updateSku: updateSkuAction,
      }}
      lifecycle={lifecycle}
      products={productRows}
      rows={rows}
      stores={storeRows}
    />
  );
}
