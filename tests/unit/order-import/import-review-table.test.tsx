// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ImportReviewTable } from "@/components/order-import/import-review-table";
import type { EditableImportRow } from "@/components/order-import/import-row-model";

function row(overrides: Partial<EditableImportRow> = {}): EditableImportRow {
  return {
    effectiveQuantity: 1,
    errorCode: null,
    errorMessage: null,
    externalOrderNo: "PO-1",
    externalSku: "TZX-014-3-lk",
    externalSubOrderNo: "SUB-1",
    fulfillmentMode: "SYSTEM_SKU",
    fulfillmentItems: [
      {
        availableQuantity: 505,
        effectiveQuantity: 1,
        fulfillmentMode: "SYSTEM_SKU",
        id: "row-1",
        isPrimary: true,
        position: 1,
        resolvedSkuId: "sku-14-3",
        skuCode: "TZX-014-3",
        unitPriceMilliYuan: 8_000,
      },
    ],
    id: "row-1",
    quantity: 1,
    quantityMultiplier: 1,
    resolutionMethod: "NORMALIZED_SUFFIX",
    resolvedSku: { id: "sku-14-3", name: "桔色", skuCode: "TZX-014-3" },
    revision: 1,
    rowNumber: 2,
    siblingCandidates: [
      { availableQuantity: 505, id: "sku-14-3", name: "桔色", skuCode: "TZX-014-3" },
      { availableQuantity: 86, id: "sku-14-2", name: "紫色", skuCode: "TZX-014-2" },
    ],
    status: "READY",
    ...overrides,
  };
}

describe("ImportReviewTable", () => {
  afterEach(cleanup);

  it("keeps ready rows compact, opens failed rows, and filters to rows needing attention", () => {
    render(
      <ImportReviewTable
        action={vi.fn()}
        addItemAction={vi.fn()}
        batchId="batch-1"
        removeItemAction={vi.fn()}
        rows={[
          row(),
          row({
            errorCode: "INSUFFICIENT_STOCK",
            errorMessage: "对应 SKU 库存不足，请更换 SKU",
            externalOrderNo: "PO-2",
            id: "row-2",
            resolvedSku: null,
            rowNumber: 3,
            status: "UNKNOWN_SKU",
          }),
        ]}
        updateItemAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("list", { name: "订单逐行核对结果" })).toBeVisible();
    expect(screen.getByRole("button", { name: "修改 Excel 第 2 行" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("region", { name: "Excel 第 2 行编辑器" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起 Excel 第 3 行" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("region", { name: "Excel 第 3 行编辑器" })).toBeVisible();
    expect(screen.getByText("对应 SKU 库存不足，请更换 SKU")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByRole("region", { name: "Excel 第 2 行编辑器" })).toBeVisible();

    fireEvent.click(screen.getByRole("checkbox", { name: "仅看需处理（1）" }));
    expect(screen.queryByRole("listitem", { name: "Excel 第 2 行" })).not.toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Excel 第 3 行" })).toBeVisible();
  });

  it("shows the authorized batch AI control with the fixed privacy disclosure", async () => {
    const generateAction = vi.fn(
      async (state: unknown, formData: FormData) => {
        void state;
        void formData;
        return {
          message: "已生成 2 个智能建议，请逐行确认后保存。",
          status: "success" as const,
        };
      },
    );
    render(
      <ImportReviewTable
        action={vi.fn()}
        addItemAction={vi.fn()}
        aiSkuMatching={{ generateAction, rejectAction: vi.fn() }}
        batchId="43f18cb3-9dc2-4651-94d3-e1ed67d89b15"
        removeItemAction={vi.fn()}
        rows={[
          row({
            id: "row-unknown",
            resolvedSku: null,
            status: "UNKNOWN_SKU",
          }),
        ]}
        updateItemAction={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "仅发送商品名称、规格和 SKU 信息至 DeepSeek，不发送收件人、地址、联系方式或订单标识。",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "智能推荐待匹配 SKU" }),
    );
    await waitFor(() => expect(generateAction).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(generateAction.mock.calls[0]![1])).toEqual({
      batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
    });
    expect(screen.getByRole("status")).toHaveTextContent("已生成 2 个智能建议");
  });
});
