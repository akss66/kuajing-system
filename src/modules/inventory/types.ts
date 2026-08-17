export type ReserveInventoryInput = {
  skuId: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  expiresAt?: Date;
};

export const INVENTORY_MOVEMENT_REASON_CODES = [
  "RESTOCK_RECEIPT",
  "OFFLINE_FULFILLMENT",
  "CUSTOMER_RETURN",
  "DAMAGED_WRITE_OFF",
  "STOCKTAKE_CORRECTION",
  "OTHER",
  "SYSTEM_SHIPMENT",
  "SHIPMENT_REVERSAL",
  "FEISHU_INITIAL_IMPORT",
  "SKU_INITIAL_STOCK",
] as const;

export type InventoryMovementReasonCode =
  (typeof INVENTORY_MOVEMENT_REASON_CODES)[number];
export type InventoryAdjustmentDirection = "INCREASE" | "DECREASE";

export const MANUAL_INVENTORY_REASON_CODES = {
  DECREASE: ["OFFLINE_FULFILLMENT", "DAMAGED_WRITE_OFF", "OTHER"],
  INCREASE: ["RESTOCK_RECEIPT", "CUSTOMER_RETURN", "OTHER"],
} as const satisfies Record<
  InventoryAdjustmentDirection,
  readonly InventoryMovementReasonCode[]
>;

export type ManualInventoryReasonCode =
  (typeof MANUAL_INVENTORY_REASON_CODES)[InventoryAdjustmentDirection][number];

export const DEFAULT_MANUAL_INVENTORY_REASON = {
  DECREASE: "OFFLINE_FULFILLMENT",
  INCREASE: "RESTOCK_RECEIPT",
} as const satisfies Record<
  InventoryAdjustmentDirection,
  ManualInventoryReasonCode
>;

export function isManualInventoryReasonCode(
  direction: InventoryAdjustmentDirection,
  reasonCode: InventoryMovementReasonCode,
): reasonCode is ManualInventoryReasonCode {
  return (MANUAL_INVENTORY_REASON_CODES[direction] as readonly string[]).includes(
    reasonCode,
  );
}

export function inventoryReasonLabel(
  reasonCode: InventoryMovementReasonCode,
  direction?: InventoryAdjustmentDirection,
): string {
  switch (reasonCode) {
    case "RESTOCK_RECEIPT":
      return "补货入库";
    case "OFFLINE_FULFILLMENT":
      return "线下发货/人工出库";
    case "CUSTOMER_RETURN":
      return "客户退货入库";
    case "DAMAGED_WRITE_OFF":
      return "破损报废";
    case "STOCKTAKE_CORRECTION":
      return "盘点调整";
    case "OTHER":
      if (direction === "INCREASE") return "其他入库";
      if (direction === "DECREASE") return "其他出库";
      throw new Error("OTHER inventory reason requires a direction");
    case "SYSTEM_SHIPMENT":
      return "系统发货扣减";
    case "SHIPMENT_REVERSAL":
      return "发货撤销回补";
    case "FEISHU_INITIAL_IMPORT":
      return "飞书初始导入";
    case "SKU_INITIAL_STOCK":
      return "SKU 初始库存";
  }
}

export type AdjustTotalInventoryInput = {
  skuId: string;
  direction: InventoryAdjustmentDirection;
  quantity: number;
  actorType: "ADMIN";
  actorId: string;
  reasonCode: ManualInventoryReasonCode;
  remark?: string | null;
};

export type SetInventoryToActualCountInput = {
  skuId: string;
  actualTotalQuantity: number;
  actorType: "ADMIN";
  actorId: string;
  reasonCode: "STOCKTAKE_CORRECTION";
  remark?: string | null;
};

export type InventoryReservation = {
  id: string;
  skuId: string;
  quantity: number;
  status: "ACTIVE" | "RELEASED" | "CONSUMED";
};

export type InventoryMovement = {
  id: string;
  skuId: string;
  movementType: "MANUAL_INCREASE" | "MANUAL_DECREASE" | "SHIPMENT" | "REVERSAL";
  beforeQuantity: number;
  delta: number;
  afterQuantity: number;
  reasonCode: InventoryMovementReasonCode | null;
  remark: string | null;
  stocktakeBatchId: string | null;
};

export type SetInventoryToActualCountResult =
  | {
      status: "NO_CHANGE";
      totalQuantity: number;
    }
  | {
      movement: InventoryMovement;
      status: "CHANGED";
      stocktakeBatchId: string;
    };
