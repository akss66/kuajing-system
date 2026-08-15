export const REQUIRED_SOURCE_SEQUENCE_COUNT = 76;
export const REQUIRED_SKU_COUNT = 140;
const AUDITED_CARGO_PRICE_PLACEHOLDER = {
  skuCode: "TZX-076",
  unitPriceMilliYuan: 99_000,
} as const;

export type CatalogFieldRefreshCliArguments = {
  apply: boolean;
  cargoPricePlaceholders: Array<{
    skuCode: string;
    unitPriceMilliYuan: number;
  }>;
  expectedSkuCount: number;
  expectedSourceSequenceCount: number;
  reason: string;
};

function optionValue(argumentsList: readonly string[], name: string) {
  const prefix = `--${name}=`;
  const value = argumentsList.find((argument) => argument.startsWith(prefix));
  return value === undefined ? undefined : value.slice(prefix.length);
}

function parseCargoPricePlaceholders(argumentsList: readonly string[]) {
  const optionName = "--cargo-price-placeholder";
  const prefix = `${optionName}=`;
  const values = argumentsList.filter(
    (argument) => argument === optionName || argument.startsWith(prefix),
  );
  const skuCodes = new Set<string>();

  return values.map((argument) => {
    const match = /^(TZX-\d+(?:-\d+)?):(\d+\.\d{2})$/.exec(
      argument.slice(prefix.length),
    );
    if (!match) throw new Error("INVALID_CARGO_PRICE_PLACEHOLDER");

    const [, skuCode, yuanText] = match;
    if (skuCodes.has(skuCode)) {
      throw new Error("INVALID_CARGO_PRICE_PLACEHOLDER");
    }
    skuCodes.add(skuCode);

    const [wholeYuan, fractionalYuan] = yuanText.split(".");
    const unitPriceMilliYuan = Number.parseInt(
      `${wholeYuan}${fractionalYuan}0`,
      10,
    );
    if (!Number.isSafeInteger(unitPriceMilliYuan) || unitPriceMilliYuan <= 0) {
      throw new Error("INVALID_CARGO_PRICE_PLACEHOLDER");
    }
    if (
      skuCode !== AUDITED_CARGO_PRICE_PLACEHOLDER.skuCode ||
      unitPriceMilliYuan !== AUDITED_CARGO_PRICE_PLACEHOLDER.unitPriceMilliYuan
    ) {
      throw new Error("INVALID_CARGO_PRICE_PLACEHOLDER");
    }
    return { skuCode, unitPriceMilliYuan };
  });
}

export function parseCatalogFieldRefreshCliArguments(
  argumentsList: readonly string[],
): CatalogFieldRefreshCliArguments {
  const apply = argumentsList.includes("--apply");
  const expectedSourceSequenceText = optionValue(
    argumentsList,
    "expected-source-sequences",
  );
  const expectedSkuText = optionValue(argumentsList, "expected-skus");
  const reasonText = optionValue(argumentsList, "reason");
  const cargoPricePlaceholders = parseCargoPricePlaceholders(argumentsList);
  const expectedSourceSequenceCount = Number(
    expectedSourceSequenceText ?? REQUIRED_SOURCE_SEQUENCE_COUNT,
  );
  const expectedSkuCount = Number(expectedSkuText ?? REQUIRED_SKU_COUNT);
  const reason = reasonText?.trim() ?? "";

  if (apply && expectedSourceSequenceText === undefined) {
    throw new Error("APPLY_EXPECTED_SOURCE_SEQUENCES_REQUIRED");
  }
  if (apply && expectedSkuText === undefined) {
    throw new Error("APPLY_EXPECTED_SKUS_REQUIRED");
  }
  if (apply && reasonText === undefined) {
    throw new Error("APPLY_REASON_REQUIRED");
  }
  if (
    apply &&
    (expectedSourceSequenceCount !== REQUIRED_SOURCE_SEQUENCE_COUNT ||
      expectedSkuCount !== REQUIRED_SKU_COUNT)
  ) {
    throw new Error("APPLY_EXPECTED_COUNTS_MISMATCH");
  }
  if (apply && reason.length === 0) {
    throw new Error("APPLY_REASON_REQUIRED");
  }

  return {
    apply,
    cargoPricePlaceholders,
    expectedSkuCount,
    expectedSourceSequenceCount,
    reason,
  };
}
