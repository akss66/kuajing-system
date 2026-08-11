import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { CustomerShell } from "@/components/layout/customer-shell";
import { getCurrentPrincipal } from "@/modules/identity/principal";

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (principal.kind !== "CUSTOMER") redirect("/admin");
  return <CustomerShell>{children}</CustomerShell>;
}
