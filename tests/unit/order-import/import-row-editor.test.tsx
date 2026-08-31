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
    fulfillmentItems: [
      {
        availableQuantity: 0,
        effectiveQuantity: 2,
        fulfillmentMode: "SYSTEM_SKU",
        id: "row-1",
        isPrimary: true,
        position: 1,
        resolvedSkuId: "sku-24",
        skuCode: "TZX-024",
        unitPriceMilliYuan: 8_000,
      },
    ],
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
  aiRejectAction?: React.ComponentProps<typeof ImportRowEditor>["aiRejectAction"],
  itemActions: Pick<
    React.ComponentProps<typeof ImportRowEditor>,
    "addItemAction" | "removeItemAction" | "updateItemAction"
  > = {
    addItemAction: vi.fn(),
    removeItemAction: vi.fn(),
    updateItemAction: vi.fn(),
  },
) {
  return render(
    <ImportRowEditor
      action={action}
      {...itemActions}
      aiRejectAction={aiRejectAction}
      batchId="batch-1"
      row={row}
    />,
  );
}

describe("ImportRowEditor", () => {
  beforeEach(() => {
    navigationMocks.refresh.mockReset();
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(cleanup);

  it("shows original and effective fulfillment data with an explicit pass result", () => {
    renderEditor(systemRow());

    const row = screen.getByRole("listitem", { name: "Excel 第 2 行" });
    expect(row).toHaveClass("rounded-2xl", "bg-white");
    expect(within(row).getByText("TZX-024-2PCS")).toBeVisible();
    expect(within(row).getByText(/1\. TZX-024/)).toBeVisible();
    expect(within(row).getByText(/× 2/)).toBeVisible();
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
    const siblingSelect = screen.getByRole("combobox", { name: "同系列替代 SKU" });
    expect(siblingSelect).toHaveAttribute("data-slot", "select-trigger");
    fireEvent.pointerDown(siblingSelect, { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(await screen.findByRole("option", { name: /TZX-024 · 米白 · 可用库存 0/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /TZX-024-1 · 粉色 · 可用库存 8/ })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(screen.getByRole("option", { name: /TZX-024-1 · 粉色 · 可用库存 8/ }));
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
    await waitFor(() => expect(navigationMocks.refresh).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent("已保存并重新校验。");
  });

  it("allows a customer-supplied item to switch SKU and add another independent item", async () => {
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
        fulfillmentItems: [
          {
            availableQuantity: null,
            effectiveQuantity: 1,
            fulfillmentMode: "CUSTOMER_SUPPLIED",
            id: "row-1",
            isPrimary: true,
            position: 1,
            resolvedSkuId: null,
            skuCode: "QS-014-1-LK",
            unitPriceMilliYuan: null,
          },
        ],
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        quantityMultiplier: 1,
        resolutionMethod: "CUSTOMER_SUPPLIED",
        resolvedSku: null,
        siblingCandidates: [],
      }),
      action,
    );

    expect(screen.queryByLabelText("同系列替代 SKU")).not.toBeInTheDocument();
    expect(screen.getByText("仅收运费")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByLabelText("手动填写最终 SKU")).toHaveValue("QS-014-1-LK");
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
      skuCode: "QS-014-1-LK",
    });

    fireEvent.click(screen.getByRole("button", { name: "加一个货" }));
    expect(screen.getByLabelText("新增货品 SKU")).toBeVisible();
    expect(screen.getByLabelText("新增货品数量")).toHaveValue(1);
  });

  it("edits and removes persisted additional fulfillment items", () => {
    renderEditor(
      systemRow({
        fulfillmentItems: [
          ...systemRow().fulfillmentItems,
          {
            availableQuantity: null,
            effectiveQuantity: 3,
            fulfillmentMode: "CUSTOMER_SUPPLIED",
            id: "item-2",
            isPrimary: false,
            position: 2,
            resolvedSkuId: null,
            skuCode: "CUSTOM-EXTRA",
            unitPriceMilliYuan: null,
          },
        ],
      }),
    );

    expect(screen.getByText(/2\. CUSTOM-EXTRA/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "修改 Excel 第 2 行" }));
    expect(screen.getByLabelText("第 2 个货品 SKU")).toHaveValue("CUSTOM-EXTRA");
    expect(screen.getByRole("button", { name: "删除第 2 个货品" })).toBeEnabled();
  });

  it("does not label a mixed bundle as shipping-only", () => {
    renderEditor(
      systemRow({
        externalSku: "SELLER-BUNDLE",
        fulfillmentItems: [
          {
            availableQuantity: null,
            effectiveQuantity: 1,
            fulfillmentMode: "CUSTOMER_SUPPLIED",
            id: "row-1",
            isPrimary: true,
            position: 1,
            resolvedSkuId: null,
            skuCode: "SELLER-BUNDLE",
            unitPriceMilliYuan: null,
          },
          {
            availableQuantity: 8,
            effectiveQuantity: 2,
            fulfillmentMode: "SYSTEM_SKU",
            id: "item-2",
            isPrimary: false,
            position: 2,
            resolvedSkuId: "sku-24",
            skuCode: "TZX-024",
            unitPriceMilliYuan: 8_000,
          },
        ],
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        resolutionMethod: "CUSTOMER_SUPPLIED",
        resolvedSku: null,
      }),
    );

    expect(screen.getByText("校验通过")).toBeVisible();
    expect(screen.getByText(/系统 SKU 收货款并校验库存.*物流费只收一次/)).toBeVisible();
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

  it("lets the customer select or reject a bounded AI candidate without auto-saving", async () => {
    const saveAction = vi.fn(async () => ({ status: "idle" as const }));
    const rejectAction = vi.fn(
      async (state: unknown, formData: FormData) => {
        void state;
        void formData;
        return {
          message: "已记录反馈，您可以继续手工填写 SKU。",
          status: "success" as const,
        };
      },
    );
    renderEditor(
      systemRow({
        aiSuggestion: {
          candidates: [
            {
              available: true,
              availableQuantity: 8,
              color: "红色",
              combination: null,
              confidence: "HIGH",
              name: "红色款",
              productName: "牵引绳",
              rank: 1,
              reason: "商品、颜色和规格一致",
              skuCode: "TZX-RED",
              skuId: "sku-red",
              specification: "150×80",
              unitPriceMilliYuan: 8_000,
            },
            {
              available: false,
              availableQuantity: 0,
              color: "黑色",
              combination: null,
              confidence: "LOW",
              name: "黑色款",
              productName: "牵引绳",
              rank: 2,
              reason: "名称相近",
              skuCode: "TZX-BLACK-WITH-A-VERY-LONG-SKU-CODE",
              skuId: "sku-black",
              specification: "150×80",
              unitPriceMilliYuan: 8_000,
            },
          ],
          id: "ab611461-ec62-46ea-81a1-f60687bbfde7",
          rowId: "row-1",
          rowRevision: 3,
        },
        resolvedSku: null,
        status: "UNKNOWN_SKU",
      }),
      saveAction,
      rejectAction,
    );

    expect(screen.getByText("DeepSeek 智能建议")).toBeVisible();
    expect(screen.getByRole("button", { name: /使用 TZX-RED/ })).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: /使用 TZX-BLACK-WITH-A-VERY-LONG-SKU-CODE/,
      }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /使用 TZX-RED/ }));
    expect(screen.getByLabelText("手动填写最终 SKU")).toHaveValue("TZX-RED");
    expect(
      document.querySelector<HTMLInputElement>('input[name="aiSuggestionId"]'),
    ).toHaveValue("ab611461-ec62-46ea-81a1-f60687bbfde7");
    expect(saveAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("手动填写最终 SKU"), {
      target: { value: "TZX-MANUAL" },
    });
    expect(
      document.querySelector('input[name="aiSuggestionId"]'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "这些都不合适" }));
    await waitFor(() => expect(rejectAction).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(rejectAction.mock.calls[0]![1])).toEqual({
      batchId: "batch-1",
      suggestionId: "ab611461-ec62-46ea-81a1-f60687bbfde7",
    });
  });

  it("explains when a row was confirmed from an AI suggestion", () => {
    renderEditor(systemRow({ resolutionMethod: "AI_CONFIRMED" }));

    expect(
      screen.getByText(
        "已确认智能建议 TZX-024；保存时已重新校验价格、库存和销售状态。",
      ),
    ).toBeVisible();
  });
});
