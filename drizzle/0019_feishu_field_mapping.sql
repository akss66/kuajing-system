ALTER TABLE "products" ADD COLUMN "source_sequence" varchar(64);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "link_text" varchar(500);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cargo_unit_price_milli_yuan" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "products_source_sequence_unique" ON "products" USING btree ("source_sequence") WHERE "products"."source_sequence" is not null;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_cargo_unit_price_milli_yuan_non_negative" CHECK ("products"."cargo_unit_price_milli_yuan" >= 0);
