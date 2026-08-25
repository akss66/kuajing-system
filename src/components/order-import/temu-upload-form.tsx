"use client";

import {
  FileCheck2,
  FileSpreadsheet,
  LoaderCircle,
  LockKeyhole,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  INITIAL_TEMU_UPLOAD_STATE,
  type TemuUploadActionState,
} from "@/modules/order-import/action-state";

type UploadAction = (
  previousState: TemuUploadActionState,
  formData: FormData,
) => Promise<TemuUploadActionState>;

export function TemuUploadForm({
  action,
  stores,
}: {
  action: UploadAction;
  stores: Array<{ id: string; name: string; platform: string }>;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_TEMU_UPLOAD_STATE,
  );
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "success" && state.batchId) {
      router.push(`/portal/imports/${state.batchId}`);
    }
  }, [router, state.batchId, state.status]);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.3fr)]">
        <label className="min-w-0 space-y-2 text-sm font-medium text-ink">
          选择店铺
          <select
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 sm:text-sm"
            name="storeId"
            required
          >
            <option value="">选择订单所属店铺</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name} · {store.platform}
              </option>
            ))}
          </select>
        </label>

        <div className="min-w-0 space-y-2 text-sm font-medium text-ink">
          <span>TEMU 订单 Excel</span>
          <label className="group flex min-h-24 min-w-0 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-primary/30 bg-primary-soft/25 px-5 py-5 text-center transition-[background-color,border-color] hover:border-primary/55 hover:bg-primary-soft/45 sm:flex-row sm:justify-start sm:text-left">
            <input
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="TEMU 订单 Excel"
              className="sr-only"
              name="temuWorkbook"
              onChange={(event) =>
                setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null)
              }
              required
              type="file"
            />
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary shadow-sm transition-transform group-hover:-translate-y-0.5">
              {selectedFileName ? (
                <FileCheck2 aria-hidden="true" className="size-5" />
              ) : (
                <FileSpreadsheet aria-hidden="true" className="size-5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm font-semibold text-foreground">
                {selectedFileName ?? "尚未选择文件"}
              </strong>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {selectedFileName ? "点击可重新选择" : "点击选择 .xlsx 文件，最大 10 MB"}
              </span>
            </span>
            <span className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-white shadow-sm">
              {selectedFileName ? "更换文件" : "选择文件"}
            </span>
          </label>
        </div>
      </div>

      <div className="flex gap-3 rounded-lg border border-border bg-surface p-3 text-sm text-muted">
        <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          系统不会保存原始 Excel 文件；收件姓名、电话和地址会在写入数据库前加密。
        </p>
      </div>

      {state.message ? (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            state.status === "success"
              ? "border-success/20 bg-success/5 text-success"
              : "border-danger/20 bg-danger/5 text-danger",
          )}
          role={state.status === "error" ? "alert" : "status"}
        >
          {state.message}
        </div>
      ) : null}

      <Button
        className="min-h-11 w-full px-5 sm:w-auto sm:min-w-48"
        disabled={pending || stores.length === 0}
        type="submit"
      >
        {pending ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <Upload aria-hidden="true" />
        )}
        {pending ? "正在解析订单" : "上传并生成预览"}
      </Button>
    </form>
  );
}
