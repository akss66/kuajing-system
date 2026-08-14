import { CatalogWorkspace } from "@/components/catalog/catalog-workspace";
import { db } from "@/db/client";
import { customers, stores } from "@/db/schema";
import {
  createSkuAction,
  createSkuAliasAction,
  setCustomerPriceAction,
} from "@/modules/catalog/actions";
import { listAdminCatalog } from "@/modules/catalog/admin-catalog";

export default async function CatalogPage() {
  const [rows, customerRows, storeRows] = await Promise.all([
    listAdminCatalog(),
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
