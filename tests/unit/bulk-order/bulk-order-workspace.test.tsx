// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BulkOrderWorkspace,
  type BulkOrderWorkspaceDraft,
  type BulkOrderWorkspaceGroup,
  type BulkOrderWorkspaceStore,
} from "@/components/bulk-order/bulk-order-workspace";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

const actionMocks = vi.hoisted(() => ({
  addStoreGroupAction: vi.fn(),
  removeStoreGroupFileAction: vi.fn(),
  submitBulkDraftAction: vi.fn(),
  uploadStoreGroupFilesAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/modules/bulk-order/actions", () => actionMocks);

const stores: BulkOrderWorkspaceStore[] = [
  { id: "store-a", name: "深圳店", platform: "TEMU" },
  { id: "store-b", name: "杭州店", platform: "TEMU" },
];

function createGroup(
  overrides: Partial<BulkOrderWorkspaceGroup> & Pick<BulkOrderWorkspaceGroup, "groupId" | "storeId" | "storeName">,
): BulkOrderWorkspaceGroup {
  const { groupId, storeId, storeName, ...groupOverrides } = overrides;

  return {
    deduplicatedOrderCount: 3,
    existingOrderCount: 0,
    fileCount: 1,
    files: [
      {
        batchId: `${groupId}-file-1`,
        fileName: `${storeName}.xlsx`,
        fileSizeBytes: 1024,
        invalidRows: 0,
        rawOrderCount: 3,
        totalQuantity: 3,
        unknownSkuRows: 0,
      },
    ],
    groupId,
    helperText: undefined,
    invalidRowCount: 0,
    rawOrderCount: 3,
    sameStoreDuplicateCount: 0,
    status: "SUBMITTABLE",
    statusLabel: "可提交",
    storeId,
    storeName,
    totalAmountFen: 12800,
    totalQuantity: 3,
    unknownSkuCount: 0,
    ...groupOverrides,
  };
}

function createDraft(groups: BulkOrderWorkspaceGroup[]): BulkOrderWorkspaceDraft {
  return {
    createdAt: "2026-08-12T09:00:00.000Z",
    expiresAt: "2026-08-12T10:00:00.000Z",
    id: "draft-1",
    groups,
    status: "DRAFT",
    updatedAt: "2026-08-12T09:05:00.000Z",
  };
}

describe("BulkOrderWorkspace", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    actionMocks.addStoreGroupAction.mockReset();
    actionMocks.removeStoreGroupFileAction.mockReset();
    actionMocks.submitBulkDraftAction.mockReset();
    actionMocks.uploadStoreGroupFilesAction.mockReset();
    routerMocks.push.mockReset();
    routerMocks.refresh.mockReset();
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");
  });

  it("defaults to all submittable groups selected and keeps wallet deduction at zero", () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({
            groupId: "group-b",
            storeId: "store-b",
            storeName: "杭州店",
            deduplicatedOrderCount: 6,
            rawOrderCount: 6,
            totalAmountFen: 16000,
            totalQuantity: 6,
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    expect(screen.getByText("已选 2 个店铺")).toBeInTheDocument();
    expect(screen.getAllByLabelText("本次使用钱包抵扣（元）")[0]).toHaveValue(0);
  });

  it("rebuilds the default selection when current groups change after refresh", async () => {
    const { rerender } = render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({
            groupId: "group-b",
            storeId: "store-b",
            storeName: "杭州店",
            fileCount: 0,
            files: [],
            helperText: "文件需要重新上传",
            status: "EMPTY",
            statusLabel: "等待上传",
            totalAmountFen: 0,
            totalQuantity: 0,
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    expect(screen.getByText("已选 1 个店铺")).toBeInTheDocument();

    rerender(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({
            groupId: "group-a",
            storeId: "store-a",
            storeName: "深圳店",
            fileCount: 0,
            files: [],
            helperText: "需要重新上传文件",
            status: "EMPTY",
            statusLabel: "等待上传",
            totalAmountFen: 0,
            totalQuantity: 0,
          }),
          createGroup({
            groupId: "group-b",
            storeId: "store-b",
            storeName: "杭州店",
            deduplicatedOrderCount: 4,
            rawOrderCount: 4,
            totalAmountFen: 15600,
            totalQuantity: 4,
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("已选 1 个店铺")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "选择杭州店" })).toHaveAttribute(
        "data-state",
        "checked",
      );
      expect(screen.getByRole("checkbox", { name: "选择深圳店" })).toBeDisabled();
    });
  });

  it("keeps only the first submittable group expanded on mobile by default", () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft(
          Array.from({ length: 8 }, (_, index) =>
            createGroup({
              groupId: `group-${index + 1}`,
              storeId: `store-${index + 1}`,
              storeName: `店铺 ${index + 1}`,
            }),
          ),
        )}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    expect(document.querySelectorAll('[data-collapsed="false"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(7);
    expect(screen.getAllByRole("button", { name: "展开详情" })).toHaveLength(7);
  });

  it("collapses mobile details for idle store cards after the first one", async () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({
            groupId: "group-a",
            storeId: "store-a",
            storeName: "深圳店",
            fileCount: 0,
            files: [],
            helperText: "请继续上传文件",
            status: "EMPTY",
            statusLabel: "等待上传",
            totalAmountFen: 0,
            totalQuantity: 0,
          }),
          createGroup({
            groupId: "group-b",
            storeId: "store-b",
            storeName: "杭州店",
            fileCount: 0,
            files: [],
            helperText: "请继续上传文件",
            status: "EMPTY",
            statusLabel: "等待上传",
            totalAmountFen: 0,
            totalQuantity: 0,
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    expect(
      document.querySelector('[aria-controls="group-details-group-b"]'),
    ).toHaveTextContent("展开详情");
    const collapsedSections = document.querySelectorAll('[data-collapsed="true"]');
    expect(collapsedSections).toHaveLength(1);

    fireEvent.click(
      document.querySelector('[aria-controls="group-details-group-b"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[aria-controls="group-details-group-b"]'),
      ).toHaveTextContent("收起详情");
      expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(0);
    });
  });

  it("auto-expands the target group before restoring focus after a submit error", async () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({ groupId: "group-b", storeId: "store-b", storeName: "杭州店" }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(
      document.querySelector('[aria-controls="group-details-group-a"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "选择深圳店" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择杭州店" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(1);
      expect(screen.getByRole("checkbox", { name: "选择深圳店" })).toHaveFocus();
    });
  });

  it("lets operators manually collapse and reopen submittable groups", async () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({ groupId: "group-b", storeId: "store-b", storeName: "杭州店" }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(
      document.querySelector('[aria-controls="group-details-group-b"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-collapsed="false"]')).toHaveLength(2);
      expect(
        document.querySelector('[aria-controls="group-details-group-b"]'),
      ).toHaveTextContent("收起详情");
    });

    fireEvent.click(
      document.querySelector('[aria-controls="group-details-group-b"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(1);
      expect(
        document.querySelector('[aria-controls="group-details-group-b"]'),
      ).toHaveTextContent("展开详情");
    });
  });

  it("preserves a manual deselection while pruning blocked groups and selecting newly submittable groups", async () => {
    const { rerender } = render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({ groupId: "group-b", storeId: "store-b", storeName: "杭州店" }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择深圳店" }));
    expect(screen.getByRole("checkbox", { name: "选择深圳店" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    rerender(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
          createGroup({
            groupId: "group-b",
            storeId: "store-b",
            storeName: "杭州店",
            helperText: "订单信息异常",
            status: "BLOCKED_INVALID",
            statusLabel: "需要修复",
          }),
          createGroup({
            groupId: "group-c",
            storeId: "store-c",
            storeName: "广州店",
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "选择深圳店" })).toHaveAttribute(
        "data-state",
        "unchecked",
      );
      expect(screen.getByRole("checkbox", { name: "选择杭州店" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "选择广州店" })).toHaveAttribute(
        "data-state",
        "checked",
      );
    });
  });

  it("focuses the store selector when trying to create a blank store group", async () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增店铺分组" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("请选择店铺后再新增分组。");
      expect(screen.getByRole("combobox", { name: "新增店铺分组" })).toHaveFocus();
    });
  });

  it("focuses the file input when uploading without selecting a file", async () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({
            groupId: "group-a",
            storeId: "store-a",
            storeName: "深圳店",
            fileCount: 0,
            files: [],
            helperText: "请继续上传文件",
            status: "EMPTY",
            statusLabel: "等待上传",
            totalAmountFen: 0,
            totalQuantity: 0,
          }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上传该店铺文件" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("请先为该店铺选择至少一个 Excel 文件。");
      expect(screen.getByLabelText("继续上传该店铺文件")).toHaveFocus();
    });
  });

  it("focuses the first selectable checkbox when submitting with an empty selection", async () => {
    actionMocks.submitBulkDraftAction.mockResolvedValue({
      ok: false,
      message: "请至少选择一个可提交的店铺分组。",
    });

    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择深圳店" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("请至少选择一个可提交的店铺分组。");
      expect(screen.getByRole("checkbox", { name: "选择深圳店" })).toHaveFocus();
    });
  });

  it("reuses the same idempotency key for the same failed payload and rotates it after payload change", async () => {
    actionMocks.submitBulkDraftAction
      .mockResolvedValueOnce({
        ok: false,
        message: "结算提交失败，请重试。",
      })
      .mockResolvedValueOnce({
        ok: false,
        message: "结算提交失败，请重试。",
      })
      .mockResolvedValueOnce({
        ok: false,
        message: "结算提交失败，请重试。",
      });

    render(
      <BulkOrderWorkspace
        draft={createDraft([
          createGroup({ groupId: "group-a", storeId: "store-a", storeName: "深圳店" }),
        ])}
        stores={stores}
        walletPosition={{ activeHoldFen: 120000, availableFen: 520000, balanceFen: 660000 }}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
    );
    await waitFor(() => expect(actionMocks.submitBulkDraftAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
      ).toBeEnabled(),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
    );
    await waitFor(() => expect(actionMocks.submitBulkDraftAction).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
      ).toBeEnabled(),
    );

    fireEvent.change(screen.getAllByLabelText("本次使用钱包抵扣（元）")[0], {
      target: { value: "18" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "提交拿货单并进入结算" })[0],
    );
    await waitFor(() => expect(actionMocks.submitBulkDraftAction).toHaveBeenCalledTimes(3));

    expect(actionMocks.submitBulkDraftAction.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(actionMocks.submitBulkDraftAction.mock.calls[1]?.[0]).toMatchObject({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(actionMocks.submitBulkDraftAction.mock.calls[2]?.[0]).toMatchObject({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
  });
});
