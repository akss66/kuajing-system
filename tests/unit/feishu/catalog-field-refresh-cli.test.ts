import { describe, expect, test } from "vitest";

import { parseCatalogFieldRefreshCliArguments } from "@/modules/feishu/catalog-field-refresh-cli";

describe("parseCatalogFieldRefreshCliArguments", () => {
  test("parses an audited cargo price placeholder without floating-point rounding", () => {
    expect(parseCatalogFieldRefreshCliArguments([
      "--cargo-price-placeholder=TZX-076:99.00",
    ])).toMatchObject({
      cargoPricePlaceholders: [
        { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
      ],
    });
  });

  test.each([
    ["--cargo-price-placeholder=TZX-076:99.0"],
    ["--cargo-price-placeholder=TZX-076:99.001"],
    ["--cargo-price-placeholder=TZX-076:0.00"],
    ["--cargo-price-placeholder=TZX-076:-1.00"],
    ["--cargo-price-placeholder=TZ-076:99.00"],
    ["--cargo-price-placeholder=TZX-999:99.00"],
    ["--cargo-price-placeholder=TZX-076-1:99.00"],
    ["--cargo-price-placeholder=TZX-076:099.00"],
    ["--cargo-price-placeholder=TZX-076:00099.00"],
    ["--cargo-price-placeholder=TZX-076:99.00", "--cargo-price-placeholder=TZX-076:99.00"],
  ])("rejects an invalid cargo price placeholder", (...argumentsList) => {
    expect(() => parseCatalogFieldRefreshCliArguments(argumentsList))
      .toThrow("INVALID_CARGO_PRICE_PLACEHOLDER");
  });

  test("requires an explicit source-sequence count when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-skus=140", "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_SOURCE_SEQUENCES_REQUIRED");
  });

  test("requires an explicit SKU count when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=76", "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_SKUS_REQUIRED");
  });

  test("requires an explicit operator reason when applying", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=76", "--expected-skus=140",
    ])).toThrow("APPLY_REASON_REQUIRED");
  });

  test.each([
    ["--expected-source-sequences=74", "--expected-skus=140"],
    ["--expected-source-sequences=76", "--expected-skus=139"],
  ])("rejects wrong apply confirmation counts", (sourceSequenceArgument, skuArgument) => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", sourceSequenceArgument, skuArgument, "--reason=confirmed repair",
    ])).toThrow("APPLY_EXPECTED_COUNTS_MISMATCH");
  });

  test("rejects a blank explicit apply reason", () => {
    expect(() => parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=76", "--expected-skus=140", "--reason=   ",
    ])).toThrow("APPLY_REASON_REQUIRED");
  });

  test("accepts all four explicit apply guards", () => {
    expect(parseCatalogFieldRefreshCliArguments([
      "--apply", "--expected-source-sequences=76", "--expected-skus=140", "--reason=confirmed repair",
    ])).toEqual({
      apply: true,
      cargoPricePlaceholders: [],
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 76,
      reason: "confirmed repair",
    });
  });

  test("uses preview defaults without requiring a reason", () => {
    expect(parseCatalogFieldRefreshCliArguments([])).toEqual({
      apply: false,
      cargoPricePlaceholders: [],
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 76,
      reason: "",
    });
  });
});
