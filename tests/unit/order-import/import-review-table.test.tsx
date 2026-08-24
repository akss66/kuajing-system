// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        batchId="batch-1"
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
      />,
    );

    expect(screen.getByRole("table", { name: "逐行校验结果" })).toHaveClass(
      "block",
      "md:table",
    );
    expect(screen.getByRole("button", { name: "修改 Excel 第 2 行" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("row", { name: "Excel 第 2 行编辑器" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起 Excel 第 3 行" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("row", { name: "Excel 第 3 行编辑器" })).toBeVisible();
    expect(screen.getByText("对应 SKU 库存不足，请更换 SKU")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByRole("row", { name: "Excel 第 2 行编辑器" })).toBeVisible();

    fireEvent.click(screen.getByRole("checkbox", { name: "仅看需处理（1）" }));
    expect(screen.queryByRole("row", { name: "Excel 第 2 行" })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Excel 第 3 行" })).toBeVisible();
  });
});
