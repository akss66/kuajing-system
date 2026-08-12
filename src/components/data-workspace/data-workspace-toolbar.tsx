import type { ReactNode } from "react";

export function DataWorkspaceToolbar({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div
      className="flex flex-col gap-4 border-b border-border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
      data-workspace-toolbar
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink sm:text-[0.95rem]">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
