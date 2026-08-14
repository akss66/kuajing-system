CREATE TYPE "public"."inventory_movement_reason_code" AS ENUM('RESTOCK_RECEIPT', 'OFFLINE_FULFILLMENT', 'CUSTOMER_RETURN', 'DAMAGED_WRITE_OFF', 'STOCKTAKE_CORRECTION', 'OTHER', 'SYSTEM_SHIPMENT', 'SHIPMENT_REVERSAL', 'FEISHU_INITIAL_IMPORT');--> statement-breakpoint
CREATE TABLE "inventory_stocktake_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "reason_code" "inventory_movement_reason_code";--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "stocktake_batch_id" uuid;--> statement-breakpoint
UPDATE "inventory_movements"
SET "reason_code" = CASE
	WHEN "reference_type" = 'FEISHU_CARGO_MIGRATION' THEN 'FEISHU_INITIAL_IMPORT'::"inventory_movement_reason_code"
	WHEN "movement_type" = 'SHIPMENT' AND "reference_type" = 'ORDER_SHIPMENT' THEN 'SYSTEM_SHIPMENT'::"inventory_movement_reason_code"
	WHEN "movement_type" = 'REVERSAL' THEN 'SHIPMENT_REVERSAL'::"inventory_movement_reason_code"
END
WHERE "reason_code" IS NULL
	AND (
		"reference_type" = 'FEISHU_CARGO_MIGRATION'
		OR ("movement_type" = 'SHIPMENT' AND "reference_type" = 'ORDER_SHIPMENT')
		OR "movement_type" = 'REVERSAL'
	);--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stocktake_batch_id_inventory_stocktake_batches_id_fk" FOREIGN KEY ("stocktake_batch_id") REFERENCES "public"."inventory_stocktake_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_created_id_index" ON "inventory_movements" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_movements_type_created_id_index" ON "inventory_movements" USING btree ("movement_type","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_movements_actor_created_id_index" ON "inventory_movements" USING btree ("actor_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_movements_reason_created_id_index" ON "inventory_movements" USING btree ("reason_code","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
