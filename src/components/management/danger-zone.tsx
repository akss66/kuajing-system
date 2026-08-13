import { useId, type ReactNode } from "react"

type DangerZoneProps = {
  title?: string
  description: string
  children: ReactNode
}

export function DangerZone({
  title = "危险操作",
  description,
  children,
}: DangerZoneProps) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="space-y-4 border border-destructive/30 bg-destructive/[0.04] p-4"
    >
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-medium text-destructive">
          {title}
        </h3>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  )
}

export type { DangerZoneProps }
