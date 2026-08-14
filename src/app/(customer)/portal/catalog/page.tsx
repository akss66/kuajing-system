import { CustomerCatalogWorkspace } from "@/components/catalog/customer-catalog-workspace";
import {
  listCustomerCatalog,
  type CustomerCatalogItem,
} from "@/modules/catalog/customer-catalog";
import { getCurrentPrincipal } from "@/modules/identity/principal";

export function matchesCustomerCatalogQuery(
  item: CustomerCatalogItem,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;

  return [item.skuCode, item.productName, item.specification, item.linkText].some(
    (value) => value?.toLocaleLowerCase("zh-CN").includes(normalized) ?? false,
  );
}

export default async function CustomerCatalogPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal || principal.kind !== "CUSTOMER") return null;

  const query = (await searchParams).q?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const items = (await listCustomerCatalog(principal.customerId)).filter((item) =>
    matchesCustomerCatalogQuery(item, query),
  );

  return <CustomerCatalogWorkspace items={items} query={query} />;
}
