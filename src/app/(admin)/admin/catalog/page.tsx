import { desc, eq } from "drizzle-orm";

import { CatalogWorkspace } from "@/components/catalog/catalog-workspace";
import { db } from "@/db/client";
import { customers, products, skus, stores } from "@/db/schema";
import {
  createSkuAction,
  createSkuAliasAction,
  setCustomerPriceAction,
} from "@/modules/catalog/actions";

export default async function CatalogPage() {
  const [rows, customerRows, storeRows] = await Promise.all([
    db
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
      .orderBy(desc(skus.createdAt)),
    db
      .select({ code: customers.code, id: customers.id })
      .from(customers)
      .orderBy(customers.code),
    db
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .orderBy(stores.name),
  ]);

  return (
    <CatalogWorkspace
      actions={{
        createAlias: createSkuAliasAction,
        createSku: createSkuAction,
        setCustomerPrice: setCustomerPriceAction,
      }}
      customers={customerRows}
      rows={rows}
      stores={storeRows}
    />
  );
}
