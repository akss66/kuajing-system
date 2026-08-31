CREATE TABLE "order_import_row_fulfillment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"final_sku_code" varchar(160) NOT NULL,
	"effective_quantity" integer NOT NULL,
	"fulfillment_mode" "order_line_kind" NOT NULL,
	"resolved_sku_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_row_fulfillment_items_position_range" CHECK ("order_import_row_fulfillment_items"."position" between 2 and 20),
	CONSTRAINT "order_import_row_fulfillment_items_sku_not_blank" CHECK (nullif(trim("order_import_row_fulfillment_items"."final_sku_code"), '') is not null),
	CONSTRAINT "order_import_row_fulfillment_items_quantity_positive" CHECK ("order_import_row_fulfillment_items"."effective_quantity" > 0),
	CONSTRAINT "order_import_row_fulfillment_items_mode_consistent" CHECK (("order_import_row_fulfillment_items"."fulfillment_mode" = 'SYSTEM_SKU' and "order_import_row_fulfillment_items"."resolved_sku_id" is not null) or ("order_import_row_fulfillment_items"."fulfillment_mode" = 'CUSTOMER_SUPPLIED' and "order_import_row_fulfillment_items"."resolved_sku_id" is null))
);
--> statement-breakpoint
ALTER TABLE "order_import_row_fulfillment_items" ADD CONSTRAINT "order_import_row_fulfillment_items_row_id_order_import_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."order_import_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_row_fulfillment_items" ADD CONSTRAINT "order_import_row_fulfillment_items_resolved_sku_id_skus_id_fk" FOREIGN KEY ("resolved_sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_import_row_fulfillment_items_row_position_unique" ON "order_import_row_fulfillment_items" USING btree ("row_id","position");--> statement-breakpoint
CREATE INDEX "order_import_row_fulfillment_items_row_index" ON "order_import_row_fulfillment_items" USING btree ("row_id");--> statement-breakpoint
CREATE INDEX "order_import_row_fulfillment_items_sku_index" ON "order_import_row_fulfillment_items" USING btree ("resolved_sku_id");