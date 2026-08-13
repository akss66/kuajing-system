"use client";

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_ACTION_STATE,
  type ManagedAction,
} from "@/shared/action-state";

export function ActionForm({
  action,
  children,
  className,
  submitClassName,
  submitLabel,
}: {
  action: ManagedAction;
  children: ReactNode;
  className?: string;
  submitClassName?: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_ACTION_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state.status]);

  const errors = Object.values(state.fieldErrors ?? {}).flat();

  return (
    <form action={formAction} className={className} ref={formRef}>
      {children}
      {errors.length || state.message ? (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm lg:col-span-full",
            state.status === "success"
              ? "border-success/20 bg-success/5 text-success"
              : "border-danger/20 bg-danger/5 text-danger",
          )}
          role={state.status === "error" ? "alert" : "status"}
        >
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          {state.message ? <p>{state.message}</p> : null}
        </div>
      ) : null}
      <Button className={cn("min-h-11 px-4", submitClassName)} disabled={pending} type="submit">
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
        {pending ? "正在保存" : submitLabel}
      </Button>
    </form>
  );
}
