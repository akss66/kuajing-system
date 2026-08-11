import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/layout/admin-shell";
import { getCurrentPrincipal } from "@/modules/identity/principal";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (principal.kind !== "ADMIN") redirect("/portal");

  return <AdminShell>{children}</AdminShell>;
}
