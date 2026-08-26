"use client";

import {
  FileCheck2,
  FileSpreadsheet,
  LoaderCircle,
  LockKeyhole,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type DragEvent,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const acceptDroppedFile = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files[0];
    if (!file || !fileInputRef.current) return;

    if (typeof DataTransfer !== "undefined") {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInputRef.current.files = transfer.files;
    }
    setSelectedFileName(file.name);
  };

  useEffect(() => {
    if (state.status === "success" && state.batchId) {
      router.push(`/portal/imports/${state.batchId}`);
    }
  }, [router, state.batchId, state.status]);

  return (
    <form action={formAction} className="space-y-6">
      <div className="min-w-0 space-y-2">
        <label
          className="block text-sm font-medium text-ink"
          id="temu-upload-store-label"
        >
          选择店铺
        </label>
        <Select name="storeId" required>
          <SelectTrigger
            aria-labelledby="temu-upload-store-label"
            aria-required="true"
            className="min-h-12 w-full border-input bg-background px-3.5 text-base sm:text-sm"
            data-portal-control="store-picker"
          >
            <SelectValue placeholder="选择订单所属店铺" />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            {stores.map((store) => (
              <SelectItem key={store.id} value={store.id}>
                {store.name} · {store.platform}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-0 space-y-2 text-sm font-medium text-ink">
        <span>TEMU 订单 Excel</span>
        <label
          className={cn(
            "group flex min-h-44 min-w-0 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-7 text-center transition-[background-color,border-color,box-shadow,transform] duration-200 sm:flex-row sm:justify-start sm:text-left",
            dragActive
              ? "scale-[1.005] border-primary bg-primary-soft/70 shadow-[0_14px_34px_rgb(15_118_110/0.12)]"
              : "border-primary/30 bg-primary-soft/25 hover:border-primary/60 hover:bg-primary-soft/45",
          )}
          data-drag-active={dragActive ? "true" : "false"}
          data-file-ready={selectedFileName ? "true" : "false"}
          data-testid="temu-workbook-dropzone"
          data-upload-dropzone
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(
                event.relatedTarget as Node | null,
              )
            ) {
              setDragActive(false);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragActive(true);
          }}
          onDrop={acceptDroppedFile}
        >
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="TEMU 订单 Excel"
            className="sr-only"
            disabled={pending}
            name="temuWorkbook"
            onChange={(event) =>
              setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null)
            }
            ref={fileInputRef}
            required
            type="file"
          />
          <span
            className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-background text-primary shadow-[0_8px_24px_rgb(15_55_47/0.08)] transition-transform group-hover:-translate-y-1"
            data-upload-icon
          >
            {selectedFileName ? (
              <FileCheck2 aria-hidden="true" className="size-6" />
            ) : (
              <FileSpreadsheet aria-hidden="true" className="size-6" />
            )}
          </span>
          <span className="mt-4 min-w-0 max-w-lg sm:ml-5 sm:mt-0 sm:flex-1">
            <strong
              aria-live="polite"
              className="block truncate text-base font-semibold text-foreground"
            >
              {selectedFileName ?? "将 Excel 文件拖到这里"}
            </strong>
            <span className="mt-1.5 block text-sm font-normal leading-6 text-muted-foreground">
              {selectedFileName
                ? "文件已就绪；拖入或点击可重新选择"
                : "也可以点击选择 TEMU 原始 .xlsx 文件，单个文件最大 10 MB"}
            </span>
          </span>
          <span className="mt-4 inline-flex min-h-10 shrink-0 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-white shadow-sm sm:ml-5 sm:mt-0">
            {selectedFileName ? "更换文件" : "选择文件"}
          </span>
        </label>
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

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-stretch">
        <div className="flex gap-3 rounded-xl border border-border bg-surface p-3 text-sm leading-6 text-muted">
          <LockKeyhole aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" />
          <p>
            系统不会保存原始 Excel 文件；收件姓名、电话和地址会在写入数据库前加密。
          </p>
        </div>
        <Button
          className="min-h-12 w-full px-6 text-base lg:min-w-56"
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
      </div>
    </form>
  );
}
