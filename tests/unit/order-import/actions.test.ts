import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const guardMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
  addCustomerImportRowFulfillmentItem: vi.fn(),
  removeCustomerImportRowFulfillmentItem: vi.fn(),
  updateCustomerImportRowFulfillmentItem: vi.fn(),
  updateCustomerImportRowOverride: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/order-import/service", () => ({
  ImportPreviewError: class ImportPreviewError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  createTemuImportPreview: vi.fn(),
  addCustomerImportRowFulfillmentItem:
    serviceMocks.addCustomerImportRowFulfillmentItem,
  removeCustomerImportRowFulfillmentItem:
    serviceMocks.removeCustomerImportRowFulfillmentItem,
  updateCustomerImportRowFulfillmentItem:
    serviceMocks.updateCustomerImportRowFulfillmentItem,
  updateCustomerImportRowOverride: serviceMocks.updateCustomerImportRowOverride,
}));

import {
  addCustomerImportRowFulfillmentItemAction,
  removeCustomerImportRowFulfillmentItemAction,
  updateCustomerImportRowAction,
  updateCustomerImportRowFulfillmentItemAction,
} from "@/modules/order-import/actions";

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const validForm = () =>
  form({
    batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
    effectiveQuantity: "4",
    expectedRevision: "3",
    rowId: "73cf219b-9864-49d8-88c2-c28162525c7e",
    skuCode: "  TZX-999  ",
  });

describe("updateCustomerImportRowAction", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireCustomer.mockReset();
    serviceMocks.updateCustomerImportRowOverride.mockReset();
    serviceMocks.addCustomerImportRowFulfillmentItem.mockReset();
    serviceMocks.removeCustomerImportRowFulfillmentItem.mockReset();
    serviceMocks.updateCustomerImportRowFulfillmentItem.mockReset();
    guardMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-from-session",
      userId: "user-from-session",
    });
    serviceMocks.updateCustomerImportRowOverride.mockResolvedValue({});
    serviceMocks.addCustomerImportRowFulfillmentItem.mockResolvedValue({});
    serviceMocks.removeCustomerImportRowFulfillmentItem.mockResolvedValue({});
    serviceMocks.updateCustomerImportRowFulfillmentItem.mockResolvedValue({});
  });

  it("requires a fresh customer session before validation or mutation", async () => {
    const accessError = new Error("UNAUTHENTICATED");
    guardMocks.requireCustomer.mockRejectedValueOnce(accessError);

    await expect(
      updateCustomerImportRowAction({ status: "idle" }, validForm()),
    ).rejects.toBe(accessError);
    expect(serviceMocks.updateCustomerImportRowOverride).not.toHaveBeenCalled();
  });

  it("uses the authenticated customer and bounded CAS inputs", async () => {
    const data = validForm();
    data.set("customerId", "attacker-customer");
    data.set("fulfillmentMode", "CUSTOMER_SUPPLIED");
    data.set("price", "0");

    const result = await updateCustomerImportRowAction({ status: "idle" }, data);

    expect(serviceMocks.updateCustomerImportRowOverride).toHaveBeenCalledWith({
      actorUserId: "user-from-session",
      aiSuggestionId: undefined,
      batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
      customerId: "customer-from-session",
      effectiveQuantity: 4,
      expectedRevision: 3,
      rowId: "73cf219b-9864-49d8-88c2-c28162525c7e",
      skuCode: "TZX-999",
    });
    expect(result).toEqual({ message: "已保存并重新校验。", status: "success" });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/portal/imports/43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
    );
  });

  it("adds a trimmed non-empty fulfillment SKU under the authenticated customer", async () => {
    const result = await addCustomerImportRowFulfillmentItemAction(
      { status: "idle" },
      form({
        batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
        effectiveQuantity: "2",
        expectedRevision: "3",
        rowId: "73cf219b-9864-49d8-88c2-c28162525c7e",
        skuCode: "  CUSTOM-BUNDLE-ITEM  ",
      }),
    );

    expect(serviceMocks.addCustomerImportRowFulfillmentItem).toHaveBeenCalledWith({
      actorUserId: "user-from-session",
      batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
      customerId: "customer-from-session",
      effectiveQuantity: 2,
      expectedRevision: 3,
      rowId: "73cf219b-9864-49d8-88c2-c28162525c7e",
      skuCode: "CUSTOM-BUNDLE-ITEM",
    });
    expect(result).toEqual({ message: "已添加货品并重新校验。", status: "success" });
  });

  it("updates and removes only a validated child item without trusting client ownership", async () => {
    const base = {
      batchId: "43f18cb3-9dc2-4651-94d3-e1ed67d89b15",
      expectedRevision: "3",
      itemId: "1fb85ee5-326b-4613-a3bb-f33292da61d9",
      rowId: "73cf219b-9864-49d8-88c2-c28162525c7e",
    };
    const updateData = form({
      ...base,
      customerId: "attacker-customer",
      effectiveQuantity: "4",
      skuCode: "  TZX-011-1  ",
    });
    await updateCustomerImportRowFulfillmentItemAction(
      { status: "idle" },
      updateData,
    );
    await removeCustomerImportRowFulfillmentItemAction(
      { status: "idle" },
      form(base),
    );

    expect(serviceMocks.updateCustomerImportRowFulfillmentItem).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "customer-from-session",
        effectiveQuantity: 4,
        itemId: base.itemId,
        skuCode: "TZX-011-1",
      }),
    );
    expect(serviceMocks.removeCustomerImportRowFulfillmentItem).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "customer-from-session",
        itemId: base.itemId,
      }),
    );
  });

  it.each(["", "   "])("rejects an empty added SKU (%j)", async (skuCode) => {
    const data = validForm();
    data.set("skuCode", skuCode);

    const result = await addCustomerImportRowFulfillmentItemAction(
      { status: "idle" },
      data,
    );

    expect(result.status).toBe("error");
    expect(serviceMocks.addCustomerImportRowFulfillmentItem).not.toHaveBeenCalled();
  });

  it("passes a validated AI suggestion without trusting client identity fields", async () => {
    const data = validForm();
    data.set("aiSuggestionId", "ab611461-ec62-46ea-81a1-f60687bbfde7");
    data.set("customerId", "attacker-customer");

    await updateCustomerImportRowAction({ status: "idle" }, data);

    expect(serviceMocks.updateCustomerImportRowOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSuggestionId: "ab611461-ec62-46ea-81a1-f60687bbfde7",
        customerId: "customer-from-session",
      }),
    );
  });

  it("allows quantity-only updates without trusting a client fulfillment mode", async () => {
    const data = validForm();
    data.delete("skuCode");
    data.set("fulfillmentMode", "CUSTOMER_SUPPLIED");

    const result = await updateCustomerImportRowAction({ status: "idle" }, data);

    expect(result.status).toBe("success");
    expect(serviceMocks.updateCustomerImportRowOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "customer-from-session",
        effectiveQuantity: 4,
        skuCode: undefined,
      }),
    );
  });

  it.each([
    ["invalid batch", { batchId: "no" }],
    ["invalid row", { rowId: "no" }],
    ["negative revision", { expectedRevision: "-1" }],
    ["zero quantity", { effectiveQuantity: "0" }],
    ["fractional quantity", { effectiveQuantity: "1.5" }],
    ["oversized quantity", { effectiveQuantity: "1000001" }],
    ["oversized SKU", { skuCode: "X".repeat(161) }],
    ["invalid AI suggestion", { aiSuggestionId: "not-a-uuid" }],
  ])("rejects %s before calling the service", async (_name, override) => {
    const data = validForm();
    for (const [key, value] of Object.entries(override)) data.set(key, value);

    const result = await updateCustomerImportRowAction({ status: "idle" }, data);

    expect(result.status).toBe("error");
    expect(serviceMocks.updateCustomerImportRowOverride).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["IMPORT_ROW_CONFLICT", "该行已被其他操作更新，请刷新后重试。"],
    ["SKU_NOT_AVAILABLE", "SKU 不存在、已下架或不可售，请重新选择。"],
    ["INSUFFICIENT_STOCK", "对应 SKU 库存不足，请更换 SKU 或减少数量。"],
    ["AI_SUGGESTION_INVALID", "该智能建议已失效，请重新获取或手工填写。"],
  ])("returns a safe row-level message for %s", async (code, message) => {
    serviceMocks.updateCustomerImportRowOverride.mockRejectedValueOnce({ code });

    const result = await updateCustomerImportRowAction({ status: "idle" }, validForm());

    expect(result).toEqual({ message, status: "error" });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });
});
