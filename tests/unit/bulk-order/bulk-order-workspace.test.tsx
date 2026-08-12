// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

class ResizeObserverMock {
  disconnect() {}
  observe() {}
  unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/modules/bulk-order/actions", () => ({
  addStoreGroupAction: vi.fn(),
  removeGroupFileAction: vi.fn(),
  submitBulkDraftAction: vi.fn(),
  uploadGroupFilesAction: vi.fn(),
}));

import {
  BulkOrderWorkspace,
  type BulkOrderWorkspaceDraft,
} from "@/components/bulk-order/bulk-order-workspace";

function createDraft(groupCount: number): BulkOrderWorkspaceDraft {
  return {
    createdAt: "2026-08-12T08:00:00.000Z",
    expiresAt: "2026-08-13T08:00:00.000Z",
    groups: Array.from({ length: groupCount }, (_, index) => ({
      deduplicatedOrderCount: 1,
      existingOrderCount: 0,
      fileCount: 1,
      files: [
        {
          batchId: `batch-${index + 1}`,
          fileName: `store-${index + 1}.xlsx`,
          fileSizeBytes: 4096,
          invalidRows: 0,
          rawOrderCount: 1,
          totalQuantity: 2,
          unknownSkuRows: 0,
        },
      ],
      groupId: `group-${index + 1}`,
      invalidRowCount: 0,
      rawOrderCount: 1,
      sameStoreDuplicateCount: 0,
      status: "SUBMITTABLE",
      statusLabel: "可提交",
      storeId: `store-${index + 1}`,
      storeName: `店铺 ${index + 1}`,
      totalAmountFen: 1_000,
      totalQuantity: 2,
      unknownSkuCount: 0,
    })),
    id: "draft-1",
    status: "DRAFT",
    updatedAt: "2026-08-12T09:00:00.000Z",
  };
}

describe("BulkOrderWorkspace", () => {
  it("defaults to all submittable groups selected with zero wallet deduction", () => {
    render(
      <BulkOrderWorkspace
        draft={createDraft(8)}
        stores={Array.from({ length: 8 }, (_, index) => ({
          id: `store-${index + 1}`,
          name: `店铺 ${index + 1}`,
          platform: "TEMU",
        }))}
        walletPosition={{
          activeHoldFen: 2_000,
          availableFen: 8_000,
          balanceFen: 10_000,
        }}
      />,
    );

    expect(screen.getByText("8 个店铺可提交")).toBeVisible();
    expect(screen.getByLabelText("本次余额抵扣")).toHaveValue(0);
    expect(screen.getByRole("button", { name: "提交 8 个店铺" })).toBeEnabled();
  });

  it("disables blocked groups and excludes them from the default selection", () => {
    const draft = createDraft(2);
    draft.groups[1] = {
      ...draft.groups[1],
      invalidRowCount: 2,
      status: "BLOCKED_INVALID",
      statusLabel: "格式问题",
      totalAmountFen: 500,
      totalQuantity: 1,
    };

    render(
      <BulkOrderWorkspace
        draft={draft}
        stores={[
          { id: "store-1", name: "店铺 1", platform: "TEMU" },
          { id: "store-2", name: "店铺 2", platform: "TEMU" },
        ]}
        walletPosition={{
          activeHoldFen: 0,
          availableFen: 5_000,
          balanceFen: 5_000,
        }}
      />,
    );

    expect(screen.getByText("1 个店铺可提交")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "选择店铺 2" })).toBeDisabled();
    expect(screen.getAllByText("格式问题").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "提交 1 个店铺" })).toBeEnabled();
  });
});
