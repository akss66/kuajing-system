import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const databaseMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  InsufficientInventoryError: class InsufficientInventoryError extends Error {},
  InventoryBalanceNotFoundError: class InventoryBalanceNotFoundError extends Error {},
  InventoryValidationError: class InventoryValidationError extends Error {},
  adjustTotalInventory: vi.fn(),
  setInventoryToActualCount: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/db/client", () => ({
  db: { transaction: databaseMocks.transaction },
}));
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/inventory/service", () => serviceMocks);

import {
  adjustInventoryAction,
  setInventoryToActualCountAction,
} from "@/modules/inventory/actions";
import {
  DEFAULT_MANUAL_INVENTORY_REASON,
  inventoryReasonLabel,
  MANUAL_INVENTORY_REASON_CODES,
} from "@/modules/inventory/types";

const SKU_ID = "11111111-1111-4111-8111-111111111111";

function adjustmentForm(input: {
  direction?: string;
  quantity?: string;
  reasonCode?: string;
  remark?: string;
}) {
  const formData = new FormData();
  formData.set("skuId", SKU_ID);
  if (input.direction !== undefined) formData.set("direction", input.direction);
  if (input.quantity !== undefined) formData.set("quantity", input.quantity);
  if (input.reasonCode !== undefined) formData.set("reasonCode", input.reasonCode);
  if (input.remark !== undefined) formData.set("remark", input.remark);
  return formData;
}

describe("inventory actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    databaseMocks.transaction.mockReset();
    guardMocks.requireAdmin.mockReset();
    serviceMocks.adjustTotalInventory.mockReset();
    serviceMocks.setInventoryToActualCount.mockReset();

    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "inventory-admin",
    });
    databaseMocks.transaction.mockImplementation(
      async (callback: (tx: { kind: string }) => unknown) => callback({ kind: "tx" }),
    );
    serviceMocks.adjustTotalInventory.mockResolvedValue({ id: "movement-id" });
    serviceMocks.setInventoryToActualCount.mockResolvedValue({
      movement: { id: "stocktake-movement" },
      status: "CHANGED",
      stocktakeBatchId: "stocktake-batch",
    });
  });

  it.each([
    ["INCREASE", "RESTOCK_RECEIPT"],
    ["DECREASE", "OFFLINE_FULFILLMENT"],
  ] as const)(
    "applies the %s server-side default and trims the optional remark",
    async (direction, reasonCode) => {
      const result = await adjustInventoryAction(
        { status: "idle" },
        adjustmentForm({
          direction,
          quantity: "3",
          remark: "  仓库复核后补录  ",
        }),
      );

      expect(result).toEqual({
        message: "库存已调整并记录流水。",
        status: "success",
      });
      expect(serviceMocks.adjustTotalInventory).toHaveBeenCalledWith(
        { kind: "tx" },
        {
          actorId: "inventory-admin",
          actorType: "ADMIN",
          direction,
          quantity: 3,
          reasonCode,
          remark: "仓库复核后补录",
          skuId: SKU_ID,
        },
      );
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/inventory");
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
        "/admin/inventory/movements",
      );
      expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin");
    },
  );

  it("keeps the direction matrix, defaults, and labels in one shared contract", () => {
    expect(DEFAULT_MANUAL_INVENTORY_REASON).toEqual({
      DECREASE: "OFFLINE_FULFILLMENT",
      INCREASE: "RESTOCK_RECEIPT",
    });
    expect(MANUAL_INVENTORY_REASON_CODES).toEqual({
      DECREASE: ["OFFLINE_FULFILLMENT", "DAMAGED_WRITE_OFF", "OTHER"],
      INCREASE: ["RESTOCK_RECEIPT", "CUSTOMER_RETURN", "OTHER"],
    });
    expect(inventoryReasonLabel("RESTOCK_RECEIPT", "INCREASE")).toBe("补货入库");
    expect(inventoryReasonLabel("CUSTOMER_RETURN", "INCREASE")).toBe(
      "客户退货入库",
    );
    expect(inventoryReasonLabel("OTHER", "INCREASE")).toBe("其他入库");
    expect(inventoryReasonLabel("OFFLINE_FULFILLMENT", "DECREASE")).toBe(
      "线下发货/人工出库",
    );
    expect(inventoryReasonLabel("DAMAGED_WRITE_OFF", "DECREASE")).toBe(
      "破损报废",
    );
    expect(inventoryReasonLabel("OTHER", "DECREASE")).toBe("其他出库");
    expect(inventoryReasonLabel("STOCKTAKE_CORRECTION")).toBe("盘点调整");
    expect(inventoryReasonLabel("SYSTEM_SHIPMENT")).toBe("系统发货扣减");
  });

  it.each([
    ["INCREASE", "OFFLINE_FULFILLMENT"],
    ["DECREASE", "RESTOCK_RECEIPT"],
    ["INCREASE", "STOCKTAKE_CORRECTION"],
    ["DECREASE", "SYSTEM_SHIPMENT"],
    ["DECREASE", "SHIPMENT_REVERSAL"],
    ["INCREASE", "FEISHU_INITIAL_IMPORT"],
  ])("rejects %s with manual reason %s", async (direction, reasonCode) => {
    const result = await adjustInventoryAction(
      { status: "idle" },
      adjustmentForm({ direction, quantity: "2", reasonCode }),
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.reasonCode).toBeDefined();
    expect(serviceMocks.adjustTotalInventory).not.toHaveBeenCalled();
  });

  it.each(["0", "-2", "1.5", "not-a-number"])(
    "rejects non-positive-integer quantity %s",
    async (quantity) => {
      const result = await adjustInventoryAction(
        { status: "idle" },
        adjustmentForm({ direction: "INCREASE", quantity }),
      );

      expect(result.status).toBe("error");
      expect(result.fieldErrors?.quantity).toBeDefined();
      expect(serviceMocks.adjustTotalInventory).not.toHaveBeenCalled();
    },
  );

  it("normalizes an empty remark to undefined", async () => {
    await adjustInventoryAction(
      { status: "idle" },
      adjustmentForm({ direction: "INCREASE", quantity: "1", remark: "   " }),
    );

    expect(serviceMocks.adjustTotalInventory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ remark: undefined }),
    );
  });

  it("reports the locked-inventory message only for the known insufficient error", async () => {
    serviceMocks.adjustTotalInventory.mockRejectedValue(
      new serviceMocks.InsufficientInventoryError("locked"),
    );

    const result = await adjustInventoryAction(
      { status: "idle" },
      adjustmentForm({ direction: "DECREASE", quantity: "1" }),
    );

    expect(result).toEqual({
      message: "库存调整失败：调整后总库存不能低于已锁定数量。",
      status: "error",
    });
  });

  it("does not disguise an unknown adjustment failure as locked inventory", async () => {
    serviceMocks.adjustTotalInventory.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      adjustInventoryAction(
        { status: "idle" },
        adjustmentForm({ direction: "INCREASE", quantity: "1" }),
      ),
    ).rejects.toThrow("database unavailable");
  });

  it("runs set-to-actual as the stocktake-only secondary command", async () => {
    const formData = new FormData();
    formData.set("skuId", SKU_ID);
    formData.set("actualTotalQuantity", "8");
    formData.set("reasonCode", "STOCKTAKE_CORRECTION");
    formData.set("remark", "  月末盘点  ");

    const result = await setInventoryToActualCountAction(
      { status: "idle" },
      formData,
    );

    expect(result.status).toBe("success");
    expect(serviceMocks.setInventoryToActualCount).toHaveBeenCalledWith(
      { kind: "tx" },
      {
        actorId: "inventory-admin",
        actorType: "ADMIN",
        actualTotalQuantity: 8,
        reasonCode: "STOCKTAKE_CORRECTION",
        remark: "月末盘点",
        skuId: SKU_ID,
      },
    );
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/inventory");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/inventory/movements",
    );
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it.each([
    ["-1", "STOCKTAKE_CORRECTION"],
    ["8", "SYSTEM_SHIPMENT"],
  ])(
    "rejects an invalid stocktake total/reason pair (%s, %s)",
    async (actualTotalQuantity, reasonCode) => {
      const formData = new FormData();
      formData.set("skuId", SKU_ID);
      formData.set("actualTotalQuantity", actualTotalQuantity);
      formData.set("reasonCode", reasonCode);

      const result = await setInventoryToActualCountAction(
        { status: "idle" },
        formData,
      );

      expect(result.status).toBe("error");
      expect(serviceMocks.setInventoryToActualCount).not.toHaveBeenCalled();
    },
  );

  it("reports stocktake no-change without revalidating or inventing a movement", async () => {
    serviceMocks.setInventoryToActualCount.mockResolvedValue({
      status: "NO_CHANGE",
      totalQuantity: 8,
    });
    const formData = new FormData();
    formData.set("skuId", SKU_ID);
    formData.set("actualTotalQuantity", "8");
    formData.set("reasonCode", "STOCKTAKE_CORRECTION");

    const result = await setInventoryToActualCountAction(
      { status: "idle" },
      formData,
    );

    expect(result).toEqual({
      message: "库存与盘点结果一致，未生成库存流水。",
      status: "success",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not disguise an unknown stocktake failure as locked inventory", async () => {
    serviceMocks.setInventoryToActualCount.mockRejectedValue(
      new Error("database unavailable"),
    );
    const formData = new FormData();
    formData.set("skuId", SKU_ID);
    formData.set("actualTotalQuantity", "8");
    formData.set("reasonCode", "STOCKTAKE_CORRECTION");

    await expect(
      setInventoryToActualCountAction({ status: "idle" }, formData),
    ).rejects.toThrow("database unavailable");
  });
});
