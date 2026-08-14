ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_amount_matches_quantity";--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ADD COLUMN "unit_price_milli_yuan" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "default_unit_price_milli_yuan" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "unit_price_milli_yuan" integer DEFAULT 0;--> statement-breakpoint
UPDATE "customer_sku_prices" SET "unit_price_milli_yuan" = "unit_price_fen" * 10;--> statement-breakpoint
UPDATE "skus" SET "default_unit_price_milli_yuan" = "default_unit_price_fen" * 10;--> statement-breakpoint
UPDATE "order_lines" SET "unit_price_milli_yuan" = "unit_price_fen" * 10;--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ALTER COLUMN "unit_price_milli_yuan" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ALTER COLUMN "default_unit_price_milli_yuan" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "unit_price_milli_yuan" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ADD CONSTRAINT "customer_sku_prices_unit_price_milli_yuan_non_negative" CHECK ("customer_sku_prices"."unit_price_milli_yuan" >= 0);--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ADD CONSTRAINT "customer_sku_prices_unit_price_fen_matches_milli_yuan" CHECK ("customer_sku_prices"."unit_price_fen" = (("customer_sku_prices"."unit_price_milli_yuan"::bigint + 5) / 10));--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_default_price_milli_yuan_non_negative" CHECK ("skus"."default_unit_price_milli_yuan" >= 0);--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_default_price_fen_matches_milli_yuan" CHECK ("skus"."default_unit_price_fen" = (("skus"."default_unit_price_milli_yuan"::bigint + 5) / 10));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_unit_price_milli_yuan_non_negative" CHECK ("order_lines"."unit_price_milli_yuan" >= 0);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_unit_price_fen_matches_milli_yuan" CHECK ("order_lines"."unit_price_fen" = (("order_lines"."unit_price_milli_yuan"::bigint + 5) / 10));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_amount_matches_exact_price" CHECK ("order_lines"."line_amount_fen" = (((("order_lines"."quantity")::bigint * ("order_lines"."unit_price_milli_yuan")::bigint) + 5) / 10));--> statement-breakpoint
CREATE FUNCTION "set_legacy_sku_price_milli_yuan"() RETURNS trigger AS $$
BEGIN
  IF NEW."default_unit_price_milli_yuan" = 0 AND NEW."default_unit_price_fen" <> 0 THEN
    NEW."default_unit_price_milli_yuan" := NEW."default_unit_price_fen" * 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "skus_legacy_price_milli_yuan_insert"
BEFORE INSERT ON "skus"
FOR EACH ROW EXECUTE FUNCTION "set_legacy_sku_price_milli_yuan"();--> statement-breakpoint
CREATE FUNCTION "set_legacy_customer_price_milli_yuan"() RETURNS trigger AS $$
BEGIN
  IF NEW."unit_price_milli_yuan" = 0 AND NEW."unit_price_fen" <> 0 THEN
    NEW."unit_price_milli_yuan" := NEW."unit_price_fen" * 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "customer_sku_prices_legacy_price_milli_yuan_insert"
BEFORE INSERT ON "customer_sku_prices"
FOR EACH ROW EXECUTE FUNCTION "set_legacy_customer_price_milli_yuan"();--> statement-breakpoint
CREATE FUNCTION "set_legacy_order_line_price_milli_yuan"() RETURNS trigger AS $$
BEGIN
  IF NEW."unit_price_milli_yuan" = 0 AND NEW."unit_price_fen" <> 0 THEN
    NEW."unit_price_milli_yuan" := NEW."unit_price_fen" * 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "order_lines_legacy_price_milli_yuan_insert"
BEFORE INSERT ON "order_lines"
FOR EACH ROW EXECUTE FUNCTION "set_legacy_order_line_price_milli_yuan"();
