// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigationMocks.refresh }),
}));

import {
  ImportRowEditor,
  type EditableImportRow,
} from "@/components/order-import/import-row-editor";

function systemRow(overrides: Partial<EditableImportRow> = {}): EditableImportRow {
  return {
    effectiveQuantity: 2,
    errorCode: null,
    errorMessage: null,
    externalOrderNo: "PO-1",
    externalSku: "TZX-024-2PCS",
    externalSubOrderNo: "SUB-1",
    fulfillmentMode: "SYSTEM_SKU",
    id: "row-1",
    quantity: 1,
    quantityMultiplier: 2,
    resolutionMethod: "NORMALIZED_SUFFIX",
    resolvedSku: { id: "sku-24", name: "米白", skuCode: "TZX-024" },
    revision: 3,
    rowNumber: 2,
    siblingCandidates: [
      { availableQuantity: 0, id: "sku-24", name: "米白", skuCode: "TZX-024" },
      { availableQuantity: 8, id: "sku-24-1", name: "粉色", skuCode: "TZX-024-1" },
    ],
    status: "READY",
    ...overrides,
  };
}

function renderEditor(
  row: EditableImportRow,
  action: React.ComponentProps<typeof ImportRowEditor>["action"] = vi.fn(),
) {
  return render(
    <table>
      <tbody>
        <ImportRowEditor action={action} batchId="batch-1" row={row} />
      </tbody>
    </table>,
  );
}

describe("ImportRowEditor", () => {
  beforeEach(() => navigationMocks.refresh.mockReset());
  afterEach(cleanup);

  it("shows original and effective fulfillment data with an explicit pass result", () => {
    renderEditor(systemRow());

    const row = screen.getByRole("row", { name: "Excel 第 2 行" });
    expect(row).toHaveClass("grid", "md:table-row");
    expect(within(row).getByText("TZX-024-2PCS")).toBeVisible();
    expect(within(row).getByText("TZX-024", { exact: true })).toBeVisible();
    expect(within(row).getByText("原 1")).toBeVisible();
    expect(within(row).getAllByText("2", { exact: true })).toHaveLength(2);
    expect(within(row).getByText("校验通过")).toBeVisible();
    expect(within(row).getByText(/2PCS.*实际发货 2 件/)).toBeVisible();
    expect(screen.queryByLabelText("实际发货数量")).not.toBeInTheDocument();
  });

  it("offers same-product siblings, accepts an exact manual SKU, and saves with CAS", async () => {
    const action = vi.fn(async (state: unknown, formData: FormData) => {
      void state;
      void formData;
      return {
        message: "已保存并重新校验。",
        status: "success" as const,
      };
    });
    renderEditor(systemRow(), action);

    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByRole("option", { name: /TZX-024 · 米白 · 可用库存 0/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: /TZX-024-1 · 粉色 · 可用库存 8/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("同系列替代 SKU"), {
      target: { value: "TZX-024-1" },
    });
    expect(screen.getByLabelText("手动填写最终 SKU")).toHaveValue("TZX-024-1");

    fireEvent.change(screen.getByLabelText("手动填写最终 SKU"), {
      target: { value: "TZX-999" },
    });
    fireEvent.change(screen.getByLabelText("实际发货数量"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并校验" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const submitted = action.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(submitted)).toMatchObject({
      batchId: "batch-1",
      effectiveQuantity: "4",
      expectedRevision: "3",
      rowId: "row-1",
      skuCode: "TZX-999",
    });
    await waitFor(() => expect(navigationMocks.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("已保存并重新校验。");
  });

  it("keeps customer-supplied goods free of product charge while allowing quantity correction", async () => {
    const action = vi.fn(
      async (state: unknown, formData: FormData) => {
        void state;
        void formData;
        return {
          message: "已保存并重新校验。",
          status: "success" as const,
        };
      },
    );
    renderEditor(
      systemRow({
        effectiveQuantity: 1,
        externalSku: "QS-014-1-LK",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        quantityMultiplier: 1,
        resolutionMethod: "CUSTOMER_SUPPLIED",
        resolvedSku: null,
        siblingCandidates: [],
      }),
      action,
    );

    expect(screen.queryByLabelText("同系列替代 SKU")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("手动填写最终 SKU")).not.toBeInTheDocument();
    expect(screen.getByText("仅收运费")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByLabelText("实际发货数量")).toHaveValue(1);
    expect(screen.getByRole("button", { name: "保存并校验" })).toBeEnabled();
    expect(screen.getByText(/客户自有货.*商品.*0.*包裹仍收.*13/)).toBeVisible();
    expect(screen.getByText(/正常按平台订单号匹配极风/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("实际发货数量"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并校验" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const submitted = action.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(submitted)).toEqual({
      batchId: "batch-1",
      effectiveQuantity: "3",
      expectedRevision: "3",
      rowId: "row-1",
    });
  });

  it("explains normalized LK suffix matching", () => {
    renderEditor(
      systemRow({
        effectiveQuantity: 1,
        externalSku: "TZX-014-3-lk",
        quantityMultiplier: 1,
        resolutionMethod: "NORMALIZED_SUFFIX",
        resolvedSku: { id: "sku-14-3", name: "橙色", skuCode: "TZX-014-3" },
      }),
    );

    expect(screen.getByText("已忽略平台后缀并自动匹配 TZX-014-3。")).toBeVisible();
  });

  it("renders failures with a cross and a specific recovery message", () => {
    renderEditor(
      systemRow({
        errorCode: "INSUFFICIENT_STOCK",
        errorMessage: "对应 SKU 库存不足，请更换 SKU",
        resolvedSku: null,
        status: "UNKNOWN_SKU",
      }),
    );

    expect(screen.getByText("校验失败")).toBeVisible();
    expect(screen.getByText("对应 SKU 库存不足，请更换 SKU")).toBeVisible();
  });

  it("renders duplicate rows as a neutral skip without edit controls", () => {
    renderEditor(systemRow({ status: "DUPLICATE" }));

    expect(screen.getByText("重复跳过")).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存并校验" })).not.toBeInTheDocument();
  });

  it("disables repeat submission while row validation is pending", async () => {
    let finish!: (state: { status: "success"; message: string }) => void;
    const action = vi.fn(
      () =>
        new Promise<{ status: "success"; message: string }>((resolve) => {
          finish = resolve;
        }),
    );
    renderEditor(systemRow(), action);

    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并校验" }));
    const pendingButton = await screen.findByRole("button", { name: "正在校验" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ message: "已保存并重新校验。", status: "success" });
    });
  });
});
