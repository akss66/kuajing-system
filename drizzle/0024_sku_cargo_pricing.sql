ALTER TABLE "skus" ADD COLUMN "cargo_unit_price_milli_yuan" integer;--> statement-breakpoint
UPDATE "skus"
SET "cargo_unit_price_milli_yuan" = "products"."cargo_unit_price_milli_yuan"
FROM "products"
WHERE "skus"."product_id" = "products"."id"
  AND "skus"."cargo_unit_price_milli_yuan" IS NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_cargo_unit_price_milli_yuan_non_negative" CHECK ("skus"."cargo_unit_price_milli_yuan" >= 0);
