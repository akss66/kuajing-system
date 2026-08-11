CREATE TYPE "public"."inventory_movement_type" AS ENUM('MANUAL_INCREASE', 'MANUAL_DECREASE', 'SHIPMENT', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."inventory_reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'CONSUMED');--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"sku_id" uuid PRIMARY KEY NOT NULL,
	"total_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_total_non_negative" CHECK ("inventory_balances"."total_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_id" uuid NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"before_quantity" integer NOT NULL,
	"delta" integer NOT NULL,
	"after_quantity" integer NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"reason" text NOT NULL,
	"remark" text,
	"reference_type" varchar(60),
	"reference_id" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_before_non_negative" CHECK ("inventory_movements"."before_quantity" >= 0),
	CONSTRAINT "inventory_movements_after_non_negative" CHECK ("inventory_movements"."after_quantity" >= 0),
	CONSTRAINT "inventory_movements_delta_non_zero" CHECK ("inventory_movements"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory_reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"reference_type" varchar(60) NOT NULL,
	"reference_id" varchar(160) NOT NULL,
	"expires_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("inventory_reservations"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_sku_created_index" ON "inventory_movements" USING btree ("sku_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_reference_sku_unique" ON "inventory_reservations" USING btree ("reference_type","reference_id","sku_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_active_sku_index" ON "inventory_reservations" USING btree ("sku_id") WHERE "inventory_reservations"."status" = 'ACTIVE';