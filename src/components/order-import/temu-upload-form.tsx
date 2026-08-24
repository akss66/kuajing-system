"use client";

import { FileSpreadsheet, LoaderCircle, LockKeyhole, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

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
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
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

        <label className="min-w-0 space-y-2 text-sm font-medium text-ink">
          TEMU 订单 Excel
          <span className="flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-primary/35 bg-primary-soft/35 px-4 py-4 text-center transition-colors hover:border-primary/60 hover:bg-primary-soft/55 sm:flex-row sm:text-left">
            <FileSpreadsheet aria-hidden="true" className="size-6 shrink-0 text-primary" />
            <input
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="min-w-0 max-w-full cursor-pointer text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white"
              name="temuWorkbook"
              required
              type="file"
            />
          </span>
        </label>
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
