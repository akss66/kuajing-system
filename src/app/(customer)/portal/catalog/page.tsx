import { CustomerCatalogWorkspace } from "@/components/catalog/catalog-workspace";
import { listCustomerCatalog } from "@/modules/catalog/customer-catalog";
import { getCurrentPrincipal } from "@/modules/identity/principal";

export default async function CustomerCatalogPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal || principal.kind !== "CUSTOMER") return null;

  const query = (await searchParams).q?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const items = (await listCustomerCatalog(principal.customerId)).filter(
    (item) =>
      !query ||
      item.skuCode.toLocaleLowerCase("zh-CN").includes(query) ||
      item.productName.toLocaleLowerCase("zh-CN").includes(query) ||
      item.skuName.toLocaleLowerCase("zh-CN").includes(query),
  );

  return <CustomerCatalogWorkspace items={items} query={query} />;
}
