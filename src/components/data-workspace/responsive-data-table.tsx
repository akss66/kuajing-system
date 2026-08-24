import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ResponsiveDataTable({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", className)} data-workspace-table>
      {children}
    </div>
  );
}
