import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[calc(var(--radius-control)+0.05rem)] border border-transparent bg-clip-padding text-sm font-semibold tracking-[-0.01em] whitespace-nowrap shadow-none transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-out outline-none select-none active:translate-y-px focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/22 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/18 motion-reduce:transform-none motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-[var(--duration-fast)] group-hover/button:[&_svg[data-icon=inline-end]]:translate-x-0.5 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground shadow-[inset_0_1px_rgb(255_255_255/0.22),inset_0_-1px_rgb(0_0_0/0.08),0_1px_2px_rgb(15_55_47/0.16)] hover:border-primary-hover hover:bg-primary-hover hover:shadow-[inset_0_1px_rgb(255_255_255/0.18),inset_0_-1px_rgb(0_0_0/0.1),0_4px_12px_rgb(15_55_47/0.14)] disabled:bg-primary-hover disabled:opacity-100 disabled:saturate-50",
        outline: "border-border bg-background text-foreground shadow-[inset_0_1px_rgb(255_255_255/0.78),0_1px_2px_rgb(20_45_39/0.05)] hover:border-input hover:bg-[var(--merchant-nav-hover)] hover:shadow-[inset_0_1px_rgb(255_255_255/0.82),0_3px_10px_rgb(20_45_39/0.06)]",
        secondary: "border-border/70 bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        ghost: "bg-transparent text-foreground hover:bg-[var(--merchant-nav-hover)]",
        destructive: "border-destructive/25 bg-background text-destructive hover:bg-destructive/8 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        destructiveSolid: "border-destructive bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_14%)] focus-visible:ring-destructive/25",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-2 px-3.5 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-7 gap-1 rounded-[var(--radius-control)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-[var(--radius-control)] px-2.5 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-10",
        "icon-xs": "size-7 rounded-[var(--radius-control)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[var(--radius-control)]",
        "icon-lg": "size-11 rounded-[var(--radius-control)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
