import { Fragment, isValidElement, type ReactNode } from "react"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

type EntityDrawerProps = {
  trigger: ReactNode
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  size?: "md" | "lg"
  testId?: string
}

export function EntityDrawer({
  trigger,
  title,
  description,
  children,
  size = "md",
  testId,
}: EntityDrawerProps) {
  const canUseTriggerAsChild = isValidElement(trigger) && trigger.type !== Fragment

  return (
    <Sheet>
      {canUseTriggerAsChild ? (
        <SheetTrigger asChild>{trigger}</SheetTrigger>
      ) : (
        <SheetTrigger>{trigger}</SheetTrigger>
      )}
      <SheetContent
        data-testid={testId}
        side="right"
        className={cn(
          "w-full data-[side=right]:!w-full sm:data-[side=right]:!max-w-[480px]",
          size === "lg" && "sm:max-w-[640px] sm:data-[side=right]:!max-w-[640px]",
        )}
      >
        <SheetHeader className="border-b border-border px-5 py-4 pr-12">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 py-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

export type { EntityDrawerProps }
