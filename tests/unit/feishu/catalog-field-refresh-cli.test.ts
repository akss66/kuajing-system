import { describe, expect, test } from "vitest";

import { parseCatalogFieldRefreshCliArguments } from "@/modules/feishu/catalog-field-refresh-cli";

describe("parseCatalogFieldRefreshCliArguments", () => {
  test("requires an explicit source-sequence count when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-skus=140", "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_SOURCE_SEQUENCES_REQUIRED");
  });

  test("requires an explicit SKU count when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=74", "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_SKUS_REQUIRED");
  });

  test("requires an explicit operator reason when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=74", "--expected-skus=140",
    ])).toThrow("APPLY_REASON_REQUIRED");
  });

  test.each([
    ["--expected-source-sequences=73", "--expected-skus=140"],
    ["--expected-source-sequences=74", "--expected-skus=139"],
  ])("rejects wrong apply confirmation counts", (sourceSequenceArgument, skuArgument) => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", sourceSequenceArgument, skuArgument, "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_COUNTS_MISMATCH");
  });

  test("rejects a blank explicit apply reason", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=74", "--expected-skus=140", "--reason=   ",
    ])).toThrow("APPLY_REASON_REQUIRED");
  });

  test("accepts all four explicit apply guards", () => {
    expect(parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=74", "--expected-skus=140", "--reason=confirmed repair",
    ])).toEqual({
      apply: true,
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 74,
      reason: "confirmed repair",
    });
  });

  test("uses preview defaults without requiring a reason", () => {
    expect(parseCatalogFieldRefreshCliArguments([])).toEqual({
      apply: false,
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 74,
      reason: "",
    });
  });
});
