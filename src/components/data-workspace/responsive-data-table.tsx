import type { ReactNode } from "react";

export function ResponsiveDataTable({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}
