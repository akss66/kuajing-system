ALTER TABLE "feishu_cargo_migration_runs" DROP CONSTRAINT "feishu_cargo_migration_runs_normalized_rows_json_valid";--> statement-breakpoint
UPDATE "feishu_cargo_migration_runs"
SET "normalized_rows_json" = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN element ? 'defaultUnitPriceMilliYuan' THEN element
        ELSE jsonb_set(
          element,
          '{defaultUnitPriceMilliYuan}',
          to_jsonb(((element ->> 'defaultUnitPriceFen')::bigint) * 10),
          true
        )
      END
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("feishu_cargo_migration_runs"."normalized_rows_json")
    WITH ORDINALITY AS rows(element, ordinal)
);--> statement-breakpoint
ALTER TABLE "feishu_cargo_migration_runs" ADD CONSTRAINT "feishu_cargo_migration_runs_normalized_rows_json_valid" CHECK (jsonb_typeof("feishu_cargo_migration_runs"."normalized_rows_json") = 'array' and not jsonb_path_exists("feishu_cargo_migration_runs"."normalized_rows_json", '$[*] ? (
  @.type() != "object" ||
  !exists(@.sourceRowNumber) || @.sourceRowNumber.type() != "number" || @.sourceRowNumber < 1 || @.sourceRowNumber.floor() != @.sourceRowNumber || @.sourceRowNumber > 9007199254740991 ||
  !exists(@.defaultUnitPriceFen) || @.defaultUnitPriceFen.type() != "number" || @.defaultUnitPriceFen < 0 || @.defaultUnitPriceFen.floor() != @.defaultUnitPriceFen || @.defaultUnitPriceFen > 9007199254740991 ||
  !exists(@.defaultUnitPriceMilliYuan) || @.defaultUnitPriceMilliYuan.type() != "number" || @.defaultUnitPriceMilliYuan < 0 || @.defaultUnitPriceMilliYuan.floor() != @.defaultUnitPriceMilliYuan || @.defaultUnitPriceMilliYuan > 9007199254740991 ||
  !exists(@.totalQuantity) || @.totalQuantity.type() != "number" || @.totalQuantity < 0 || @.totalQuantity.floor() != @.totalQuantity || @.totalQuantity > 9007199254740991 ||
  !exists(@.weightGrams) || !( @.weightGrams.type() == "null" || ( @.weightGrams.type() == "number" && @.weightGrams >= 0 && @.weightGrams.floor() == @.weightGrams && @.weightGrams <= 9007199254740991 ) ) ||
  !exists(@.saleStatus) ||
  !(@.saleStatus == "SELLABLE" || @.saleStatus == "NOT_SELLABLE") ||
  exists(@.**.fileToken) ||
  exists(@.**.imageFileToken)
)'::jsonpath));
