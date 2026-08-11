export type ReserveInventoryInput = {
  skuId: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  expiresAt?: Date;
};

export type AdjustTotalInventoryInput = {
  skuId: string;
  delta: number;
  actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
  actorId?: string | null;
  reason: string;
  remark?: string;
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
};
