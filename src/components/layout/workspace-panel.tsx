import type { ElementType, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

type WorkspacePanelProps<T extends ElementType> = {
  as?: T;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">;

export function WorkspacePanel<T extends ElementType = "section">({
  as,
  children,
  className,
  ...props
}: WorkspacePanelProps<T>) {
  const Component = (as ?? "section") as ElementType;

  return (
    <Component
      className={cn("rounded-[var(--radius-surface)] border border-border bg-background", className)}
      data-workspace-panel
      {...props}
    >
      {children}
    </Component>
  );
}

export function WorkspacePanelHeader({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink sm:text-[0.95rem]">{title}</h2>
        {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
