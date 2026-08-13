import { useId, type ReactNode } from "react"

import { cn } from "@/lib/utils"

type ActionableEmptyStateProps = {
  kind: "initial" | "filtered" | "error"
  title: string
  description: string
  action?: ReactNode
}

export function ActionableEmptyState({
  kind,
  title,
  description,
  action,
}: ActionableEmptyStateProps) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col items-start gap-3 border border-border bg-background p-6",
        kind === "error" && "border-destructive/30 bg-destructive/[0.04]",
      )}
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
    >
      <div className="space-y-1">
        <h2 id={titleId} className="text-base font-medium text-foreground">
          {title}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {action ? <div>{action}</div> : null}
    </section>
  )
}

export type { ActionableEmptyStateProps }
