import { redirect } from "next/navigation";

import { getCurrentPrincipal } from "@/modules/identity/principal";

export default async function CustomerPortalPlaceholder() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (principal.kind !== "CUSTOMER") redirect("/admin");

  return <main><h1>客户工作台</h1></main>;
}
