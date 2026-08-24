export type EditableImportRow = {
  id: string;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
  externalOrderNo: string | null;
  externalSubOrderNo: string | null;
  externalSku: string | null;
  quantity: number | null;
  effectiveQuantity: number | null;
  quantityMultiplier: number;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED" | null;
  resolutionMethod: string | null;
  revision: number;
  resolvedSku: { id: string; skuCode: string; name: string } | null;
  siblingCandidates: Array<{
    id: string;
    skuCode: string;
    name: string;
    availableQuantity: number;
  }>;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ImportRowActionState = {
  status: "idle" | "error" | "success";
  message?: string;
};

export type ImportRowAction = (
  previousState: ImportRowActionState,
  formData: FormData,
) => Promise<ImportRowActionState>;

export function importRowResult(row: EditableImportRow) {
  if (row.status === "DUPLICATE") return "duplicate" as const;
  if (row.status === "READY") return "ready" as const;
  return "failed" as const;
}

export function importRowExplanation(row: EditableImportRow) {
  if (row.status === "DUPLICATE") {
    return "该子订单已存在，本次自动跳过且不会重复收费。";
  }
  if (row.status !== "READY") {
    if (row.errorCode === "SKU_UNAVAILABLE") {
      return "对应 SKU 不可用，请选择同系列替代 SKU、手动输入或调整数量。";
    }
    return row.errorMessage ?? "SKU 不存在、已下架或不可售，请重新选择或手动填写。";
  }
  if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") {
    return "客户自有货：商品金额 ¥0，本包裹仍收物流费 ¥13；正常按平台订单号匹配极风。";
  }

  const sku = row.resolvedSku?.skuCode ?? "系统 SKU";
  if (row.resolutionMethod === "MANUAL_OVERRIDE") {
    return `已手动替换为 ${sku}，实际发货 ${row.effectiveQuantity ?? 0} 件。`;
  }
  if (row.quantityMultiplier > 1) {
    return `${row.quantityMultiplier}PCS 已换算为 ${sku}，实际发货 ${row.effectiveQuantity ?? 0} 件。`;
  }
  if (row.resolutionMethod === "NORMALIZED_SUFFIX") {
    return `已忽略平台后缀并自动匹配 ${sku}。`;
  }
  return `已自动匹配 ${sku}，实际发货 ${row.effectiveQuantity ?? row.quantity ?? 0} 件。`;
}
