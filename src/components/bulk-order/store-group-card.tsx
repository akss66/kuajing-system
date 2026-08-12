"use client";

import {
  AlertCircle,
  FileSpreadsheet,
  LoaderCircle,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import type { BulkOrderWorkspaceGroup } from "./bulk-order-workspace";

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

const statusTone: Record<
  BulkOrderWorkspaceGroup["status"],
  { badgeClass: string; helperClass: string; icon: typeof AlertCircle }
> = {
  ALREADY_SUBMITTED: {
    badgeClass: "bg-success/10 text-success",
    helperClass: "text-success",
    icon: AlertCircle,
  },
  BLOCKED_CROSS_STORE: {
    badgeClass: "bg-danger/10 text-danger",
    helperClass: "text-danger",
    icon: XCircle,
  },
  BLOCKED_INVALID: {
    badgeClass: "bg-danger/10 text-danger",
    helperClass: "text-danger",
    icon: XCircle,
  },
  BLOCKED_INVENTORY: {
    badgeClass: "bg-warning/10 text-warning",
    helperClass: "text-warning",
    icon: AlertCircle,
  },
  BLOCKED_UNKNOWN_SKU: {
    badgeClass: "bg-warning/10 text-warning",
    helperClass: "text-warning",
    icon: AlertCircle,
  },
  EMPTY: {
    badgeClass: "bg-surface-muted text-muted",
    helperClass: "text-muted",
    icon: AlertCircle,
  },
  EXPIRED: {
    badgeClass: "bg-surface-muted text-muted",
    helperClass: "text-muted",
    icon: AlertCircle,
  },
  SUBMITTABLE: {
    badgeClass: "bg-success/10 text-success",
    helperClass: "text-success",
    icon: AlertCircle,
  },
};

export function StoreGroupCard({
  fileInputKey,
  fileSelection,
  group,
  onFilesSelected,
  onRemoveFile,
  onSelectedChange,
  onUpload,
  removingBatchId,
  selected,
  uploading,
}: {
  fileInputKey: number;
  fileSelection: readonly File[];
  group: BulkOrderWorkspaceGroup;
  onFilesSelected: (groupId: string, files: FileList | null) => void;
  onRemoveFile: (batchId: string) => void;
  onSelectedChange: (groupId: string, selected: boolean) => void;
  onUpload: (groupId: string) => void;
  removingBatchId?: string | null;
  selected: boolean;
  uploading: boolean;
}) {
  const tone = statusTone[group.status];
  const StatusIcon = tone.icon;
  const selectable = group.status === "SUBMITTABLE";
  const editable =
    group.status !== "ALREADY_SUBMITTED" && group.status !== "EXPIRED";

  return (
    <article className="rounded-[var(--radius-surface)] border border-border bg-background">
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Checkbox
              aria-label={`选择${group.storeName}`}
              checked={selected}
              className="mt-1 size-5"
              disabled={!selectable}
              onCheckedChange={(checked) =>
                onSelectedChange(group.groupId, checked === true)
              }
            />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-ink">{group.storeName}</h2>
                <Badge className={tone.badgeClass} variant="secondary">
                  {group.statusLabel}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted">
                原始/去重订单 {group.rawOrderCount} / {group.deduplicatedOrderCount}，共{" "}
                {group.totalQuantity} 件，预计 {money(group.totalAmountFen)}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:min-w-[240px]">
            <div className="rounded-lg bg-surface px-3 py-2">
              <p className="text-xs text-muted">文件</p>
              <p className="mt-1 font-semibold text-ink">{group.fileCount}</p>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <p className="text-xs text-muted">件数</p>
              <p className="mt-1 font-semibold text-ink">{group.totalQuantity}</p>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <p className="text-xs text-muted">未知 SKU</p>
              <p className="mt-1 font-semibold text-ink">{group.unknownSkuCount}</p>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <p className="text-xs text-muted">格式问题</p>
              <p className="mt-1 font-semibold text-ink">{group.invalidRowCount}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-3 rounded-lg bg-surface px-3 py-3 text-sm">
          <StatusIcon className={cn("mt-0.5 size-4 shrink-0", tone.helperClass)} />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">
              同店重复 {group.sameStoreDuplicateCount}，历史已存在 {group.existingOrderCount}
            </p>
            <p className="mt-1 text-sm text-muted">
              {group.helperText ??
                "继续上传 TEMU 原始 Excel，系统会按店铺跨文件去重并保留失败文件。"}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-3">
          {group.files.length ? (
            group.files.map((file) => (
              <div
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
                key={file.batchId}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="size-4 text-primary" />
                    <p className="truncate font-medium text-ink">{file.fileName}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {bytes(file.fileSizeBytes)} · 原始订单 {file.rawOrderCount} · 未知 SKU{" "}
                    {file.unknownSkuRows} · 格式问题 {file.invalidRows}
                  </p>
                </div>
                <Button
                  className="min-h-11 px-4"
                  disabled={!editable || removingBatchId === file.batchId || uploading}
                  onClick={() => onRemoveFile(file.batchId)}
                  type="button"
                  variant="outline"
                >
                  {removingBatchId === file.batchId ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  移除文件
                </Button>
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted">
              还没有上传文件。请为该店铺选择一个或多个 TEMU 原始 Excel。
            </div>
          )}
        </div>

        <div className="rounded-lg border border-dashed border-border px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 flex-1">
              <label
                className="block text-sm font-medium text-ink"
                htmlFor={`group-files-${group.groupId}`}
              >
                继续上传该店铺文件
              </label>
              <input
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="mt-2 block min-h-11 w-full cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-primary-soft file:px-3 file:py-2 file:font-medium file:text-primary-hover"
                disabled={!editable || uploading}
                id={`group-files-${group.groupId}`}
                key={fileInputKey}
                multiple
                onChange={(event) => onFilesSelected(group.groupId, event.target.files)}
                type="file"
              />
              {fileSelection.length ? (
                <p className="mt-2 text-sm text-muted">
                  已选择 {fileSelection.length} 个文件：{" "}
                  {fileSelection.map((file) => file.name).join("、")}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  支持同店铺多文件上传；失败文件会保留，方便继续修复。
                </p>
              )}
            </div>
            <Button
              className="min-h-11 px-4"
              disabled={!editable || !fileSelection.length || uploading}
              onClick={() => onUpload(group.groupId)}
              type="button"
            >
              {uploading ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <Upload aria-hidden="true" />
              )}
              {uploading
                ? `上传中 ${fileSelection.length} 个文件`
                : "上传并合并该店铺"}
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}
