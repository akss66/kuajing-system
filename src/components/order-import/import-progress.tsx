import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const steps = ["选择店铺", "上传文件", "校验预览", "确认提交"] as const;

export function ImportProgress({ currentStep }: { currentStep: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="订单导入进度" className="border-y border-border bg-background">
      <ol className="grid grid-cols-2 sm:grid-cols-4">
        {steps.map((label, index) => {
          const step = index + 1;
          const completed = step < currentStep;
          const current = step === currentStep;

          return (
            <li
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 border-border px-3 py-3 sm:border-r sm:last:border-r-0",
                index < 2 ? "border-b sm:border-b-0" : "",
                current ? "bg-primary-soft/45" : "",
              )}
              key={label}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  completed
                    ? "border-primary bg-primary text-primary-foreground"
                    : current
                      ? "border-primary text-primary"
                      : "border-border text-muted",
                )}
              >
                {completed ? <Check aria-hidden="true" className="size-3.5" /> : step}
              </span>
              <span className={cn("truncate text-sm", current ? "font-semibold text-ink" : "text-muted")}>{label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
