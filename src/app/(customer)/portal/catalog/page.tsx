import { CustomerCatalogWorkspace } from "@/components/catalog/customer-catalog-workspace";
import {
  listCustomerCatalog,
} from "@/modules/catalog/customer-catalog";
import { getCurrentPrincipal } from "@/modules/identity/principal";

export default async function CustomerCatalogPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal || principal.kind !== "CUSTOMER") return null;

  const query = (await searchParams).q?.trim().toLocaleLowerCase("zh-CN") ?? "";
  const items = await listCustomerCatalog(principal.customerId);

  return <CustomerCatalogWorkspace items={items} query={query} />;
}
