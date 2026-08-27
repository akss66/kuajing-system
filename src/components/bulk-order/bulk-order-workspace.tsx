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
import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
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
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

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

type SelectionState = {
  selectedGroupIds: Set<string>;
  signature: string;
  submittableGroupIds: Set<string>;
};

type MobileDisclosureState = {
  collapsedGroupIds: Set<string>;
  signature: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
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

function buildGroupSignature(groups: readonly BulkOrderWorkspaceGroup[]) {
  return groups
    .map((group) => {
      const fileVersion = group.files.map((file) => file.batchId).join(",");
      return [
        group.groupId,
        group.status,
        group.fileCount,
        fileVersion,
        group.rawOrderCount,
        group.deduplicatedOrderCount,
      ].join(":");
    })
    .join("|");
}

function buildPayloadSignature(
  draftId: string,
  selectedGroupIds: readonly string[],
  requestedWalletFen: number,
) {
  return `${draftId}:${requestedWalletFen}:${selectedGroupIds.join(",")}`;
}

function getSubmittableGroupIds(groups: readonly BulkOrderWorkspaceGroup[]) {
  return new Set(
    groups
      .filter((group) => group.status === "SUBMITTABLE")
      .map((group) => group.groupId),
  );
}

function createMobileDisclosureState(
  groups: readonly BulkOrderWorkspaceGroup[],
): MobileDisclosureState {
  const firstSubmittableIndex = groups.findIndex(
    (group) => group.status === "SUBMITTABLE",
  );
  const expandedIndex = firstSubmittableIndex === -1 ? 0 : firstSubmittableIndex;

  return {
    collapsedGroupIds: new Set(
      groups
        .filter((_, index) => index !== expandedIndex)
        .map((group) => group.groupId),
    ),
    signature: buildGroupSignature(groups),
  };
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
      return "上传中";
  }
}

function defaultHelperText(group: BulkOrderWorkspaceGroup) {
  if (group.helperText) return group.helperText;

  switch (group.status) {
    case "BLOCKED_CROSS_STORE":
      return "检测到跨店铺文件或跨店子订单，请移除冲突文件后重新上传。";
    case "BLOCKED_UNKNOWN_SKU":
      return "存在未映射 SKU，请先联系管理员补齐映射，再继续上传该店铺文件。";
    case "BLOCKED_INVALID":
      return "文件中仍有格式问题，请修正后重新上传；失败文件会保留。";
    case "BLOCKED_INVENTORY":
      return "库存已变化，当前分组暂时不能提交；稍后可重新上传或减少数量。";
    case "ALREADY_SUBMITTED":
      return "该店铺已经生成拿货单，成功文件已锁定，不能重复提交。";
    case "EXPIRED":
      return "本次上传或文件已过期，请重新开始并上传新的 TEMU 原始 Excel。";
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
  const [pending, startAction] = useTransition();
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File[]>>({});
  const [fileInputKeys, setFileInputKeys] = useState<Record<string, number>>({});
  const [uploadingGroupId, setUploadingGroupId] = useState<string | null>(null);
  const [removingBatchId, setRemovingBatchId] = useState<string | null>(null);

  const storeSelectFieldRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const checkboxRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const idempotencyKeysRef = useRef(new Map<string, string>());

  const groups = useMemo(
    () =>
      draft.groups.map((group) => ({
        ...group,
        helperText: defaultHelperText(group),
      })),
    [draft.groups],
  );

  const groupSignature = useMemo(() => buildGroupSignature(groups), [groups]);
  const [selectionState, setSelectionState] = useState<SelectionState>(() => ({
    selectedGroupIds: createSelection(draft.groups),
    signature: buildGroupSignature(draft.groups),
    submittableGroupIds: getSubmittableGroupIds(draft.groups),
  }));
  const [selectionRestored, setSelectionRestored] = useState(false);
  const [mobileDisclosureState, setMobileDisclosureState] =
    useState<MobileDisclosureState>(() => createMobileDisclosureState(draft.groups));
  const [walletState, setWalletState] = useState(() => ({
    signature: buildGroupSignature(draft.groups),
    value: "0",
  }));

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(
        `bulk-order-selection:${draft.id}`,
      );
      if (storedValue) {
        const stored = JSON.parse(storedValue) as {
          selectedGroupIds?: unknown;
          submittableGroupIds?: unknown;
        };
        if (
          Array.isArray(stored.selectedGroupIds) &&
          stored.selectedGroupIds.every((value) => typeof value === "string") &&
          Array.isArray(stored.submittableGroupIds) &&
          stored.submittableGroupIds.every((value) => typeof value === "string")
        ) {
          const currentSubmittableGroupIds = getSubmittableGroupIds(groups);
          const previousSubmittableGroupIds = new Set<string>(
            stored.submittableGroupIds,
          );
          const previousSelectedGroupIds = new Set<string>(
            stored.selectedGroupIds,
          );
          const selectedGroupIds = new Set<string>();

          for (const groupId of currentSubmittableGroupIds) {
            if (
              !previousSubmittableGroupIds.has(groupId) ||
              previousSelectedGroupIds.has(groupId)
            ) {
              selectedGroupIds.add(groupId);
            }
          }

          // Restore only client-owned selection after hydration. Draft data
          // and group validity continue to come from the server snapshot.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSelectionState({
            selectedGroupIds,
            signature: groupSignature,
            submittableGroupIds: currentSubmittableGroupIds,
          });
        }
      }
    } catch {
      // Invalid local state must never override the safe server-backed default.
    }
    setSelectionRestored(true);
    // The detail route keys the workspace by draft identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  useEffect(() => {
    if (!selectionRestored) return;
    window.localStorage.setItem(
      `bulk-order-selection:${draft.id}`,
      JSON.stringify({
        selectedGroupIds: [...selectionState.selectedGroupIds],
        submittableGroupIds: [...selectionState.submittableGroupIds],
      }),
    );
  }, [draft.id, selectionRestored, selectionState]);

  useEffect(() => {
    if (selectionState.signature === groupSignature) return;
    const currentSubmittableGroupIds = getSubmittableGroupIds(groups);
    const selectedGroupIds = new Set<string>();

    for (const groupId of currentSubmittableGroupIds) {
      if (
        !selectionState.submittableGroupIds.has(groupId) ||
        selectionState.selectedGroupIds.has(groupId)
      ) {
        selectedGroupIds.add(groupId);
      }
    }

    // The server action refreshes draft groups asynchronously. Keep selection
    // aligned to that authoritative snapshot while preserving explicit choices.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectionState({
      selectedGroupIds,
      signature: groupSignature,
      submittableGroupIds: currentSubmittableGroupIds,
    });
  }, [groupSignature, groups, selectionState]);

  useEffect(() => {
    if (walletState.signature === groupSignature) return;
    // A refreshed draft has a new total, so the previous wallet input is stale.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWalletState({ signature: groupSignature, value: "0" });
  }, [groupSignature, walletState.signature]);

  useEffect(() => {
    if (mobileDisclosureState.signature === groupSignature) return;
    // Refreshes can add or remove store groups. Rebuild the default mobile
    // disclosure so the first actionable group stays expanded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileDisclosureState(createMobileDisclosureState(groups));
  }, [groupSignature, groups, mobileDisclosureState.signature]);

  const activeSelection = selectionState.selectedGroupIds;
  const walletInput = walletState.value;

  const addedStoreIds = useMemo(
    () => new Set(groups.map((group) => group.storeId)),
    [groups],
  );
  const selectableStores = useMemo(
    () => stores.filter((store) => !addedStoreIds.has(store.id)),
    [addedStoreIds, stores],
  );
  const selectedGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.status === "SUBMITTABLE" && activeSelection.has(group.groupId),
      ),
    [activeSelection, groups],
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
  const blockedCount = groups.filter(
    (group) => group.status !== "SUBMITTABLE" && group.status !== "ALREADY_SUBMITTED",
  ).length;

  function focusAlert() {
    queueMicrotask(() => {
      alertRef.current?.focus();
    });
  }

  function focusStoreSelect() {
    queueMicrotask(() => {
      storeSelectFieldRef.current
        ?.querySelector<HTMLButtonElement>('[role="combobox"]')
        ?.focus();
    });
  }

  function focusGroupInput(groupId: string) {
    expandGroupDetails(groupId);
    queueMicrotask(() => {
      fileInputRefs.current[groupId]?.focus();
    });
  }

  function focusFirstSelectableCheckbox() {
    const firstSelectableGroup = groups.find(
      (group) => group.status === "SUBMITTABLE",
    );
    if (!firstSelectableGroup) {
      focusAlert();
      return;
    }

    expandGroupDetails(firstSelectableGroup.groupId);
    queueMicrotask(() => {
      checkboxRefs.current[firstSelectableGroup.groupId]?.focus();
    });
  }

  function setActionError(error: unknown, fallback: string) {
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      setAlertMessage(error.message);
    } else {
      setAlertMessage(fallback);
    }
    focusAlert();
  }

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      const next = new Set(current.selectedGroupIds);
      if (checked) next.add(groupId);
      else next.delete(groupId);
      return {
        selectedGroupIds: next,
        signature: groupSignature,
        submittableGroupIds: current.submittableGroupIds,
      };
    });
  }

  function setSelectedGroupIds(
    updater: (current: SelectionState) => SelectionState,
  ) {
    setSelectionState((current) => updater(current));
  }

  function toggleGroupDetails(groupId: string) {
    setMobileDisclosureState((current) => {
      const next = new Set(current.collapsedGroupIds);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return { collapsedGroupIds: next, signature: groupSignature };
    });
  }

  function expandGroupDetails(groupId: string) {
    setMobileDisclosureState((current) => {
      if (!current.collapsedGroupIds.has(groupId)) {
        return current.signature === groupSignature
          ? current
          : { collapsedGroupIds: new Set(current.collapsedGroupIds), signature: groupSignature };
      }

      const next = new Set(current.collapsedGroupIds);
      next.delete(groupId);
      return { collapsedGroupIds: next, signature: groupSignature };
    });
  }

  function setWalletInput(value: string) {
    setWalletState({ signature: groupSignature, value });
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
      setAlertMessage("请选择店铺后再新增分组。");
      focusStoreSelect();
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
      setAlertMessage("请先为该店铺选择至少一个 Excel 文件。");
      focusGroupInput(groupId);
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

    const selectedGroupIds = [...selectedGroups.map((group) => group.groupId)].sort();
    if (!selectedGroupIds.length) {
      setAlertMessage("请至少选择一个可提交的店铺分组。");
      focusFirstSelectableCheckbox();
      return;
    }

    startAction(async () => {
      const payloadSignature = buildPayloadSignature(
        draft.id,
        selectedGroupIds,
        requestedWalletFen,
      );

      const idempotencyKey =
        idempotencyKeysRef.current.get(payloadSignature) ?? crypto.randomUUID();
      idempotencyKeysRef.current.set(payloadSignature, idempotencyKey);

      let response: SubmitBulkDraftActionResult;
      try {
        response = await submitBulkDraftAction({
          draftId: draft.id,
          idempotencyKey,
          requestedWalletFen,
          selectedGroupIds,
        });
      } catch (error) {
        setActionError(error, "提交拿货单失败，请稍后重试。");
        return;
      }

      if (!response.ok) {
        setAlertMessage(response.message);
        focusAlert();
        return;
      }

      if (response.result.settlementBatchId) {
        router.push(`/portal/settlements/${response.result.settlementBatchId}`);
        return;
      }

      setAlertMessage("没有新的拿货单生成；失败文件已保留，请修复后继续提交。");
      focusAlert();
      await refreshWorkspace();
    });
  }

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <PageHeading
        action={
          <div className="rounded-[var(--radius-surface)] border border-border bg-background px-4 py-3 text-sm text-muted">
            <p>{`上传状态：${draftStatusLabel(draft.status)}`}</p>
            <p className="mt-1">
              {`创建于 ${formatDate(draft.createdAt)}，过期于 ${formatDate(draft.expiresAt)}`}
            </p>
          </div>
        }
        breadcrumbs={[
          { href: "/portal", label: "经营概览" },
          { href: "/portal/bulk-orders", label: "多店铺上传" },
          { label: "多店铺批量上传" },
        ]}
        description="按店铺上传 TEMU 原始 Excel。系统会跨文件去重、识别跨店冲突，并把所选拿货单合并成一次付款。"
        title="多店铺批量上传"
      />

      <MetricStrip
        items={[
          { label: "分组数", value: `${groups.length}` },
          { label: "可提交店铺", value: `${submittableCount}` },
          { label: "已选分组", value: `${selectedGroups.length}` },
          { label: "已选文件", value: `${summary.fileCount}` },
        ]}
        variant="segmented"
      />

      <section className="space-y-4">
        <section className="grid gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">{`${submittableCount} 个店铺可提交`}</p>
            <div className="block space-y-2 text-sm font-medium text-ink" ref={storeSelectFieldRef}>
              <span>新增店铺分组</span>
              <Select onValueChange={setSelectedStoreId} value={selectedStoreId}>
                <SelectTrigger aria-label="新增店铺分组" className="min-h-11 w-full">
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
            </div>
          </div>
          <Button
            className="min-h-11 px-4"
            disabled={!selectableStores.length || pending}
            onClick={() => void onAddStoreGroup()}
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" />
            新增店铺分组
          </Button>
        </section>
      </section>

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
              detailsCollapsed={mobileDisclosureState.collapsedGroupIds.has(group.groupId)}
              fileInputKey={fileInputKeys[group.groupId] ?? 0}
              fileInputRef={(node) => {
                fileInputRefs.current[group.groupId] = node;
              }}
              fileSelection={selectedFiles[group.groupId] ?? []}
              group={group}
              key={group.groupId}
              onDetailsToggle={toggleGroupDetails}
              onFilesSelected={handleFilesSelected}
              onRemoveFile={onRemoveFile}
              onSelectedChange={toggleGroup}
              onUpload={onUpload}
              removingBatchId={removingBatchId}
              selected={activeSelection.has(group.groupId)}
              selectionControlRef={(node) => {
                checkboxRefs.current[group.groupId] = node;
              }}
              showMobileDisclosure={groups.length > 1}
              uploading={uploadingGroupId === group.groupId}
            />
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          className="min-h-11 px-4"
          onClick={() => startTransition(() => router.refresh())}
          type="button"
          variant="ghost"
        >
          <RefreshCcw aria-hidden="true" />
          刷新上传状态
        </Button>
      </div>

      <BulkOrderSummaryBar
        activeHoldFen={walletPosition.activeHoldFen}
        availableFen={walletPosition.availableFen}
        balanceFen={walletPosition.balanceFen}
        fileCount={summary.fileCount}
        blockedCount={blockedCount}
        onWalletInputChange={setWalletInput}
        orderCount={summary.orderCount}
        quantity={summary.quantity}
        requestedWalletFen={requestedWalletFen}
        requestedWalletInput={walletInput}
        selectedCount={selectedGroups.length}
        submitDisabled={pending}
        submitting={pending}
        totalAmountFen={summary.totalAmountFen}
        wechatDueFen={wechatDueFen}
      />
    </form>
  );
}
