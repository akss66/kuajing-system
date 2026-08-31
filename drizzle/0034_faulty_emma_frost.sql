ALTER TABLE "order_import_rows" DROP CONSTRAINT "order_import_rows_mode_resolution_consistent";--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "sku_code_snapshot" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "final_sku_code" varchar(160);--> statement-breakpoint
UPDATE "order_import_rows"
SET "final_sku_code" = "external_sku"
WHERE "fulfillment_mode" = 'CUSTOMER_SUPPLIED';--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_mode_resolution_consistent" CHECK (("order_import_rows"."fulfillment_mode" = 'SYSTEM_SKU' and "order_import_rows"."resolution_method" <> 'CUSTOMER_SUPPLIED') or ("order_import_rows"."fulfillment_mode" = 'CUSTOMER_SUPPLIED' and "order_import_rows"."resolution_method" = 'CUSTOMER_SUPPLIED' and "order_import_rows"."resolved_sku_id" is null and nullif(trim("order_import_rows"."final_sku_code"), '') is not null));
