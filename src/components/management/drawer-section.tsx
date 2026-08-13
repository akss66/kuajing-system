import { useId, type ReactNode } from "react"

type DrawerSectionProps = {
  title: string
  description?: string
  children: ReactNode
}

export function DrawerSection({ title, description, children }: DrawerSectionProps) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <section
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      className="space-y-4"
    >
      <div className="space-y-1">
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </h3>
        {description ? (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

export type { DrawerSectionProps }
