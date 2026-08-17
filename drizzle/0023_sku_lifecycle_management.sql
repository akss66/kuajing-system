CREATE TYPE "public"."sku_lifecycle_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
ALTER TYPE "public"."inventory_movement_reason_code" ADD VALUE 'SKU_INITIAL_STOCK';--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "lifecycle_status" "sku_lifecycle_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "archived_by_admin_user_id" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "archive_reason" text;--> statement-breakpoint
CREATE INDEX "skus_lifecycle_status_index" ON "skus" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE INDEX "skus_product_lifecycle_index" ON "skus" USING btree ("product_id","lifecycle_status");--> statement-breakpoint
WITH deactivated AS (
	UPDATE "customer_sku_prices"
	SET "active" = false, "updated_at" = now()
	WHERE "active" = true
	RETURNING "id"
)
INSERT INTO "audit_logs" (
	"actor_type",
	"actor_id",
	"action",
	"entity_type",
	"entity_id",
	"before_json",
	"after_json",
	"reason"
)
SELECT
	'SYSTEM',
	NULL,
	'CUSTOMER_PRICE_DEACTIVATED',
	'CATALOG',
	'customer_sku_prices',
	'{}'::jsonb,
	jsonb_build_object('deactivatedCount', count(*)),
	'货品价格统一上线，停用旧客户专属价'
FROM deactivated
HAVING count(*) > 0;
