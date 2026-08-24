CREATE TYPE "public"."import_sku_resolution_method" AS ENUM('EXACT', 'STORE_ALIAS', 'GLOBAL_ALIAS', 'NORMALIZED_SUFFIX', 'MANUAL_OVERRIDE', 'CUSTOMER_SUPPLIED', 'LEGACY');--> statement-breakpoint
CREATE TYPE "public"."order_line_kind" AS ENUM('SYSTEM_SKU', 'CUSTOMER_SUPPLIED');--> statement-breakpoint
ALTER TABLE "order_lines" ALTER COLUMN "sku_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "effective_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "quantity_multiplier" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "fulfillment_mode" "order_line_kind" DEFAULT 'SYSTEM_SKU' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "resolution_method" "import_sku_resolution_method" DEFAULT 'LEGACY' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "line_kind" "order_line_kind" DEFAULT 'SYSTEM_SKU' NOT NULL;--> statement-breakpoint
UPDATE "order_import_rows"
SET "effective_quantity" = "quantity"
WHERE "quantity" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_effective_quantity_positive_when_present" CHECK ("order_import_rows"."effective_quantity" is null or "order_import_rows"."effective_quantity" > 0);--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_quantity_multiplier_positive" CHECK ("order_import_rows"."quantity_multiplier" > 0);--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_revision_non_negative" CHECK ("order_import_rows"."revision" >= 0);--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_mode_resolution_consistent" CHECK (("order_import_rows"."fulfillment_mode" = 'SYSTEM_SKU' and "order_import_rows"."resolution_method" <> 'CUSTOMER_SUPPLIED') or ("order_import_rows"."fulfillment_mode" = 'CUSTOMER_SUPPLIED' and "order_import_rows"."resolution_method" = 'CUSTOMER_SUPPLIED' and "order_import_rows"."resolved_sku_id" is null));--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_ready_fields_consistent" CHECK ("order_import_rows"."status" <> 'READY' or ("order_import_rows"."effective_quantity" is not null and (("order_import_rows"."fulfillment_mode" = 'SYSTEM_SKU' and "order_import_rows"."resolved_sku_id" is not null) or ("order_import_rows"."fulfillment_mode" = 'CUSTOMER_SUPPLIED' and "order_import_rows"."resolved_sku_id" is null))));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_kind_fields_consistent" CHECK (("order_lines"."line_kind" = 'SYSTEM_SKU' and "order_lines"."sku_id" is not null) or ("order_lines"."line_kind" = 'CUSTOMER_SUPPLIED' and "order_lines"."sku_id" is null and "order_lines"."unit_price_milli_yuan" = 0 and "order_lines"."unit_price_fen" = 0 and "order_lines"."line_amount_fen" = 0));
