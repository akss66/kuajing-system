"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

export function CreateBulkDraftSubmit({
  disabled,
  secondary = false,
}: {
  disabled: boolean;
  secondary?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      aria-disabled={pending || disabled}
      className="min-h-12 w-full gap-2.5 px-5 sm:w-auto"
      data-portal-action="start-bulk-upload"
      disabled={pending || disabled}
      size="lg"
      type="submit"
      variant={secondary ? "outline" : "default"}
    >
      {pending ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <Plus aria-hidden="true" className="size-4" />
      )}
      {pending ? "正在创建上传" : "开始批量上传"}
    </Button>
  );
}
