import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 py-2 text-base shadow-[0_1px_1px_oklch(0.23_0.015_185/0.03)] transition-[border-color,box-shadow,background-color] duration-[var(--duration-fast)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/90 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/18 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
