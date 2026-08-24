export type ImportFulfillmentMode = "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";

export type ImportSkuDerivation = {
  fulfillmentMode: ImportFulfillmentMode;
  lookupCandidates: string[];
  quantityMultiplier: number;
};

const SYSTEM_SKU_PREFIX = /^TZX-/i;
const TERMINAL_LK_SUFFIX = /-LK$/i;
const TERMINAL_PCS_SUFFIX = /-(\d+)PCS$/i;
const MAX_DATABASE_INTEGER = 2_147_483_647;

export function deriveImportSkuResolution(externalSku: string): ImportSkuDerivation {
  if (!SYSTEM_SKU_PREFIX.test(externalSku)) {
    return {
      fulfillmentMode: "CUSTOMER_SUPPLIED",
      lookupCandidates: [],
      quantityMultiplier: 1,
    };
  }

  const lookupCandidates = [externalSku];
  let normalized = externalSku;
  if (TERMINAL_LK_SUFFIX.test(normalized)) {
    normalized = normalized.replace(TERMINAL_LK_SUFFIX, "");
    lookupCandidates.push(normalized);
  }

  let quantityMultiplier = 1;
  const pcsMatch = TERMINAL_PCS_SUFFIX.exec(normalized);
  if (pcsMatch) {
    const parsed = Number(pcsMatch[1]);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      parsed > MAX_DATABASE_INTEGER
    ) {
      throw new Error("PCS 件数必须是安全正整数");
    }
    quantityMultiplier = parsed;
    normalized = normalized.slice(0, pcsMatch.index);
    lookupCandidates.push(normalized);
  }

  return {
    fulfillmentMode: "SYSTEM_SKU",
    lookupCandidates: [...new Set(lookupCandidates)],
    quantityMultiplier,
  };
}

export function multiplyImportQuantity(quantity: number, multiplier: number) {
  const effectiveQuantity = quantity * multiplier;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    !Number.isSafeInteger(multiplier) ||
    multiplier <= 0 ||
    !Number.isSafeInteger(effectiveQuantity) ||
    effectiveQuantity > MAX_DATABASE_INTEGER
  ) {
    throw new Error("导入数量超出系统范围");
  }
  return effectiveQuantity;
}
