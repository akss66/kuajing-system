import { CircleAlert, Inbox, SearchX } from "lucide-react"
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
  const Icon = kind === "error" ? CircleAlert : kind === "filtered" ? SearchX : Inbox

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col items-center gap-4 rounded-2xl bg-white px-6 py-12 text-center shadow-[0_2px_12px_rgb(0_0_0/0.02)]",
        kind === "error" && "ring-1 ring-destructive/20",
      )}
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className={cn("flex size-16 items-center justify-center rounded-2xl bg-slate-50 text-slate-300 shadow-sm", kind === "error" && "bg-destructive/[0.06] text-destructive/60")}>
        <Icon aria-hidden="true" className="size-8" strokeWidth={1.5} />
      </span>
      <div className="max-w-md space-y-1">
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </section>
  )
}

export type { ActionableEmptyStateProps }
