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
  compact = false,
  description,
  title,
}: {
  action?: ReactNode;
  compact?: boolean;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col border-b border-border px-4 sm:flex-row sm:items-start sm:justify-between sm:px-5",
        compact ? "gap-3 py-3" : "gap-4 py-3.5",
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink sm:text-[0.95rem]">{title}</h2>
        {description ? (
          <p
            className={cn(
              "mt-1 text-sm text-muted",
              compact ? "leading-5.5" : "leading-6",
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
