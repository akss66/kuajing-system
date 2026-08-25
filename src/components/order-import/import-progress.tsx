import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const steps = ["选择店铺", "上传文件", "校验预览", "确认提交"] as const;

export function ImportProgress({ currentStep }: { currentStep: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="订单导入进度" className="py-2">
      <ol className="relative grid grid-cols-4 before:absolute before:left-[12.5%] before:right-[12.5%] before:top-4 before:h-px before:bg-border">
        {steps.map((label, index) => {
          const step = index + 1;
          const completed = step < currentStep;
          const current = step === currentStep;

          return (
            <li
              aria-current={current ? "step" : undefined}
              className="relative z-10 flex min-w-0 flex-col items-center px-1 text-center"
              key={label}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full border-2 bg-[var(--merchant-canvas)] text-xs font-semibold transition-colors",
                  completed
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : current
                      ? "border-primary bg-primary text-primary-foreground shadow-sm ring-4 ring-primary/10"
                      : "border-border bg-background text-muted-foreground",
                )}
              >
                {completed ? <Check aria-hidden="true" className="size-3.5" /> : step}
              </span>
              <span
                className={cn(
                  "mt-2 max-w-full text-[11px] leading-4 sm:text-xs",
                  current || completed
                    ? "font-semibold text-primary-hover"
                    : "font-medium text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
