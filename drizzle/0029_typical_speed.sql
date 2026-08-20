ALTER TABLE "skus" DROP CONSTRAINT "skus_default_price_fen_matches_milli_yuan";--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "default_unit_price_milli_yuan" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "default_unit_price_milli_yuan" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "default_unit_price_fen" DROP NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_legacy_sku_price_milli_yuan"() RETURNS trigger AS $$
BEGIN
  IF NEW."default_unit_price_milli_yuan" IS NULL AND NEW."default_unit_price_fen" IS NOT NULL THEN
    NEW."default_unit_price_milli_yuan" := NEW."default_unit_price_fen" * 10;
  ELSIF NEW."default_unit_price_fen" IS NULL AND NEW."default_unit_price_milli_yuan" IS NOT NULL THEN
    NEW."default_unit_price_fen" := ((NEW."default_unit_price_milli_yuan"::bigint + 5) / 10);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_default_price_fen_matches_milli_yuan" CHECK (("skus"."default_unit_price_fen" is null and "skus"."default_unit_price_milli_yuan" is null) or ("skus"."default_unit_price_fen" is not null and "skus"."default_unit_price_milli_yuan" is not null and "skus"."default_unit_price_fen" = (("skus"."default_unit_price_milli_yuan"::bigint + 5) / 10)));
