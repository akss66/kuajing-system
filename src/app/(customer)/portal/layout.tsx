import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { CustomerShell } from "@/components/layout/customer-shell";
import { getCurrentAuthenticatedPrincipal } from "@/modules/identity/principal";

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const authenticated = await getCurrentAuthenticatedPrincipal();
  if (!authenticated) redirect("/login");
  const { identity, principal } = authenticated;
  if (principal.kind !== "CUSTOMER") redirect("/admin");
  return <CustomerShell identity={identity}>{children}</CustomerShell>;
}
