export const REQUIRED_SOURCE_SEQUENCE_COUNT = 76;
export const REQUIRED_SKU_COUNT = 140;

export type CatalogFieldRefreshCliArguments = {
  apply: boolean;
  expectedSkuCount: number;
  expectedSourceSequenceCount: number;
  reason: string;
};

function optionValue(argumentsList: readonly string[], name: string) {
  const prefix = `--${name}=`;
  const value = argumentsList.find((argument) => argument.startsWith(prefix));
  return value === undefined ? undefined : value.slice(prefix.length);
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

  return { apply, expectedSkuCount, expectedSourceSequenceCount, reason };
}
