"use client";

import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useActionState, useEffect, useId, useRef } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_ACTION_STATE,
  type ManagedAction,
} from "@/shared/action-state";

export function ConfirmedActionForm({
  action,
  children,
  className,
  confirmDescription,
  confirmLabel,
  confirmTitle,
  disabled = false,
  onErrorFocus,
  submitLabel,
  variant = "destructive",
}: {
  action: ManagedAction;
  children: ReactNode;
  className?: string;
  confirmDescription: string;
  confirmLabel: string;
  confirmTitle: string;
  disabled?: boolean;
  onErrorFocus?: () => void;
  submitLabel: string;
  variant?: ComponentProps<typeof Button>["variant"];
}) {
  const formId = `confirmed-action-${useId().replaceAll(":", "")}`;
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_ACTION_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state.status]);

  useEffect(() => {
    if (state.status === "error") onErrorFocus?.();
  }, [onErrorFocus, state.status]);

  const errors = Object.values(state.fieldErrors ?? {}).flat();

  return (
    <form
      action={formAction}
      className={className}
      id={formId}
      ref={formRef}
    >
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
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            className="min-h-11 px-4"
            disabled={disabled || pending}
            type="button"
            variant={variant}
          >
            {pending ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : null}
            {pending ? "正在处理" : submitLabel}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">返回检查</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "min-h-11",
                variant === "destructive"
                  ? "!bg-[rgb(123_20_25)] !text-white hover:!bg-[rgb(102_17_21)]"
                  : undefined,
              )}
              form={formId}
              type="submit"
              variant={variant}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
