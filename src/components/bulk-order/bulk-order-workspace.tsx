"use client";

import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { CircleAlert, Plus, RefreshCcw } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  addStoreGroupAction,
  removeGroupFileAction,
  submitBulkDraftAction,
  uploadGroupFilesAction,
  type SubmitBulkDraftActionResult,
} from "@/modules/bulk-order/actions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { BulkOrderSummaryBar } from "./bulk-order-summary-bar";
import { StoreGroupCard } from "./store-group-card";

export type BulkOrderWorkspaceGroupStatus =
  | "SUBMITTABLE"
  | "BLOCKED_CROSS_STORE"
  | "BLOCKED_UNKNOWN_SKU"
  | "BLOCKED_INVALID"
  | "BLOCKED_INVENTORY"
  | "EMPTY"
  | "ALREADY_SUBMITTED"
  | "EXPIRED";

export type BulkOrderWorkspaceFile = {
  batchId: string;
  fileName: string;
  fileSizeBytes: number;
  invalidRows: number;
  rawOrderCount: number;
  totalQuantity: number;
  unknownSkuRows: number;
};

export type BulkOrderWorkspaceGroup = {
  deduplicatedOrderCount: number;
  existingOrderCount: number;
  fileCount: number;
  files: BulkOrderWorkspaceFile[];
  groupId: string;
  helperText?: string;
  invalidRowCount: number;
  rawOrderCount: number;
  sameStoreDuplicateCount: number;
  status: BulkOrderWorkspaceGroupStatus;
  statusLabel: string;
  storeId: string;
  storeName: string;
  totalAmountFen: number;
  totalQuantity: number;
  unknownSkuCount: number;
};

export type BulkOrderWorkspaceDraft = {
  createdAt: string;
  expiresAt: string;
  groups: BulkOrderWorkspaceGroup[];
  id: string;
  status: "DRAFT" | "PARTIALLY_SUBMITTED" | "COMPLETED" | "EXPIRED";
  updatedAt: string;
};

export type BulkOrderWorkspaceStore = {
  id: string;
  name: string;
  platform: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function parseYuanToFen(value: string) {
  if (!value.trim()) return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100);
}

function createSelection(groups: readonly BulkOrderWorkspaceGroup[]) {
  return new Set(
    groups
      .filter((group) => group.status === "SUBMITTABLE")
      .map((group) => group.groupId),
  );
}

function draftStatusLabel(status: BulkOrderWorkspaceDraft["status"]) {
  switch (status) {
    case "PARTIALLY_SUBMITTED":
      return "部分已提交";
    case "COMPLETED":
      return "已完成";
    case "EXPIRED":
      return "已过期";
    default:
      return "草稿中";
  }
}

function defaultHelperText(group: BulkOrderWorkspaceGroup) {
  if (group.helperText) return group.helperText;

  switch (group.status) {
    case "BLOCKED_CROSS_STORE":
      return "检测到跨店文件或跨店子订单，请移除冲突文件后重新上传。";
    case "BLOCKED_UNKNOWN_SKU":
      return "存在未知 SKU，请先联系管理员维护映射，再继续上传该店铺文件。";
    case "BLOCKED_INVALID":
      return "文件里仍有格式问题，请修正后重新上传；失败文件会保留。";
    case "BLOCKED_INVENTORY":
      return "库存已变化，当前分组暂时不能提交；稍后可重新上传或减少数量。";
    case "ALREADY_SUBMITTED":
      return "该店铺已经生成拿货单，成功文件已锁定，不能重复提交。";
    case "EXPIRED":
      return "草稿或文件已过期，请重新创建草稿并上传新的 TEMU 原始 Excel。";
    case "EMPTY":
      return "去重后没有可提交订单，请继续上传该店铺文件。";
    default:
      return "继续上传 TEMU 原始 Excel，系统会按店铺跨文件去重并保留失败文件。";
  }
}

export function BulkOrderWorkspace({
  draft,
  stores,
  walletPosition,
}: {
  draft: BulkOrderWorkspaceDraft;
  stores: BulkOrderWorkspaceStore[];
  walletPosition: {
    activeHoldFen: number;
    availableFen: number;
    balanceFen: number;
  };
}) {
  const router = useRouter();
  const alertRef = useRef<HTMLDivElement>(null);
  const [pending, startAction] = useTransition();
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    () => createSelection(draft.groups),
  );
  const [walletInput, setWalletInput] = useState("0");
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File[]>>({});
  const [fileInputKeys, setFileInputKeys] = useState<Record<string, number>>({});
  const [uploadingGroupId, setUploadingGroupId] = useState<string | null>(null);
  const [removingBatchId, setRemovingBatchId] = useState<string | null>(null);

  useEffect(() => {
    if (!alertMessage) return;
    alertRef.current?.focus();
  }, [alertMessage]);

  const groups = useMemo(
    () =>
      draft.groups.map((group) => ({
        ...group,
        helperText: defaultHelperText(group),
      })),
    [draft.groups],
  );
  const addedStoreIds = useMemo(
    () => new Set(groups.map((group) => group.storeId)),
    [groups],
  );
  const selectableStores = useMemo(
    () => stores.filter((store) => !addedStoreIds.has(store.id)),
    [addedStoreIds, stores],
  );
  const selectedGroups = useMemo(
    () => groups.filter((group) => selectedGroupIds.has(group.groupId)),
    [groups, selectedGroupIds],
  );
  const summary = useMemo(
    () =>
      selectedGroups.reduce(
        (totals, group) => {
          totals.fileCount += group.fileCount;
          totals.orderCount += group.deduplicatedOrderCount;
          totals.quantity += group.totalQuantity;
          totals.totalAmountFen += group.totalAmountFen;
          return totals;
        },
        { fileCount: 0, orderCount: 0, quantity: 0, totalAmountFen: 0 },
      ),
    [selectedGroups],
  );
  const requestedWalletFen = Math.min(
    parseYuanToFen(walletInput),
    walletPosition.availableFen,
    summary.totalAmountFen,
  );
  const wechatDueFen = Math.max(0, summary.totalAmountFen - requestedWalletFen);
  const submittableCount = groups.filter(
    (group) => group.status === "SUBMITTABLE",
  ).length;

  function setActionError(error: unknown, fallback: string) {
    if (error instanceof Error && error.message) {
      setAlertMessage(error.message);
      return;
    }
    setAlertMessage(fallback);
  }

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      const next = new Set(current);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  }

  function handleFilesSelected(groupId: string, files: FileList | null) {
    setSelectedFiles((current) => ({
      ...current,
      [groupId]: files ? Array.from(files) : [],
    }));
  }

  function clearSelectedFiles(groupId: string) {
    setSelectedFiles((current) => ({ ...current, [groupId]: [] }));
    setFileInputKeys((current) => ({
      ...current,
      [groupId]: (current[groupId] ?? 0) + 1,
    }));
  }

  async function refreshWorkspace() {
    setAlertMessage(null);
    router.refresh();
  }

  async function onAddStoreGroup() {
    if (!selectedStoreId) {
      setAlertMessage("请先选择一个尚未添加的店铺。");
      return;
    }

    startAction(async () => {
      try {
        await addStoreGroupAction({ draftId: draft.id, storeId: selectedStoreId });
        setSelectedStoreId("");
        await refreshWorkspace();
      } catch (error) {
        setActionError(error, "新增店铺分组失败，请稍后重试。");
      }
    });
  }

  async function onUpload(groupId: string) {
    const files = selectedFiles[groupId] ?? [];
    if (!files.length) {
      setAlertMessage("请先为该店铺选择至少一个 TEMU 原始 Excel。");
      return;
    }

    startAction(async () => {
      try {
        setUploadingGroupId(groupId);
        const formData = new FormData();
        formData.set("groupId", groupId);
        for (const file of files) formData.append("files", file);
        await uploadGroupFilesAction(formData);
        clearSelectedFiles(groupId);
        await refreshWorkspace();
      } catch (error) {
        setActionError(error, "上传文件失败，请检查文件格式后重试。");
      } finally {
        setUploadingGroupId(null);
      }
    });
  }

  async function onRemoveFile(batchId: string) {
    startAction(async () => {
      try {
        setRemovingBatchId(batchId);
        await removeGroupFileAction(batchId);
        await refreshWorkspace();
      } catch (error) {
        setActionError(error, "移除文件失败，请稍后重试。");
      } finally {
        setRemovingBatchId(null);
      }
    });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedGroups.length) {
      setAlertMessage("当前没有可提交店铺，请先修复被阻止的分组或新增店铺。");
      return;
    }

    startAction(async () => {
      const response: SubmitBulkDraftActionResult = await submitBulkDraftAction({
        draftId: draft.id,
        requestedWalletFen,
        selectedGroupIds: selectedGroups.map((group) => group.groupId),
      });

      if (!response.ok) {
        setAlertMessage(response.message);
        return;
      }

      if (response.result.settlementBatchId) {
        router.push(`/portal/settlements/${response.result.settlementBatchId}`);
        return;
      }

      setAlertMessage("没有新拿货单生成；失败文件已保留，请修复后继续提交。");
      await refreshWorkspace();
    });
  }

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <header className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-primary">按店铺批量拿货</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              多店铺批量拿货
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-muted">
              一个客户可按店铺上传多个 TEMU 原始 Excel，系统会跨文件去重并合并为每店一张拿货单。
            </p>
          </div>
          <div className="rounded-[var(--radius-surface)] border border-border bg-background px-4 py-3 text-sm text-muted">
            <p>草稿状态：{draftStatusLabel(draft.status)}</p>
            <p className="mt-1">
              创建于 {formatDate(draft.createdAt)}，过期于 {formatDate(draft.expiresAt)}
            </p>
          </div>
        </div>

        <section className="grid gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">{submittableCount} 个店铺可提交</p>
            <label className="block space-y-2 text-sm font-medium text-ink">
              新增店铺分组
              <Select onValueChange={setSelectedStoreId} value={selectedStoreId}>
                <SelectTrigger className="min-h-11 w-full">
                  <SelectValue placeholder="选择一个尚未添加的店铺" />
                </SelectTrigger>
                <SelectContent>
                  {selectableStores.length ? (
                    selectableStores.map((store) => (
                      <SelectItem key={store.id} value={store.id}>
                        {store.name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem disabled value="empty">
                      没有可新增的店铺
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </label>
          </div>
          <Button
            className="min-h-11 px-4"
            disabled={!selectableStores.length || pending}
            onClick={() => void onAddStoreGroup()}
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" />
            添加店铺
          </Button>
        </section>
      </header>

      {alertMessage ? (
        <div
          className="rounded-[var(--radius-surface)] border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger"
          ref={alertRef}
          role="alert"
          tabIndex={-1}
        >
          <div className="flex items-start gap-2">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>{alertMessage}</p>
          </div>
        </div>
      ) : null}

      {!groups.length ? (
        <section className="rounded-[var(--radius-surface)] border border-dashed border-border bg-background px-4 py-10 text-center sm:px-6">
          <p className="font-semibold text-ink">还没有店铺分组</p>
          <p className="mt-2 text-sm text-muted">
            先选择一个 TEMU 店铺，再上传该店铺的原始 Excel。
          </p>
        </section>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <StoreGroupCard
              fileInputKey={fileInputKeys[group.groupId] ?? 0}
              fileSelection={selectedFiles[group.groupId] ?? []}
              group={group}
              key={group.groupId}
              onFilesSelected={handleFilesSelected}
              onRemoveFile={onRemoveFile}
              onSelectedChange={toggleGroup}
              onUpload={onUpload}
              removingBatchId={removingBatchId}
              selected={selectedGroupIds.has(group.groupId)}
              uploading={uploadingGroupId === group.groupId}
            />
          ))}
        </div>
      )}

      <BulkOrderSummaryBar
        activeHoldFen={walletPosition.activeHoldFen}
        availableFen={walletPosition.availableFen}
        balanceFen={walletPosition.balanceFen}
        fileCount={summary.fileCount}
        onWalletInputChange={setWalletInput}
        orderCount={summary.orderCount}
        quantity={summary.quantity}
        requestedWalletFen={requestedWalletFen}
        requestedWalletInput={walletInput}
        selectedCount={selectedGroups.length}
        submitDisabled={!selectedGroups.length || pending}
        submitting={pending}
        totalAmountFen={summary.totalAmountFen}
        wechatDueFen={wechatDueFen}
      />

      <div className="flex justify-end">
        <Button
          className="min-h-11 px-4"
          onClick={() => startTransition(() => router.refresh())}
          type="button"
          variant="ghost"
        >
          <RefreshCcw aria-hidden="true" />
          刷新草稿
        </Button>
      </div>
    </form>
  );
}
