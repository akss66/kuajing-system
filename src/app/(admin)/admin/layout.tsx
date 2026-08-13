import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/layout/admin-shell";
import { getCurrentAuthenticatedPrincipal } from "@/modules/identity/principal";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const authenticated = await getCurrentAuthenticatedPrincipal();
  if (!authenticated) redirect("/login");
  const { identity, principal } = authenticated;
  if (principal.kind !== "ADMIN" && principal.kind !== "SUPER_ADMIN") redirect("/portal");

  return (
    <AdminShell identity={identity} principalKind={principal.kind}>
      {children}
    </AdminShell>
  );
}
