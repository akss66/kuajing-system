CREATE TYPE "public"."catalog_asset_mime_type" AS ENUM('image/jpeg', 'image/png', 'image/webp');--> statement-breakpoint
CREATE TYPE "public"."feishu_cargo_migration_status" AS ENUM('PREFLIGHT_RUNNING', 'PREFLIGHT_READY', 'PREFLIGHT_BLOCKED', 'IMPORTING', 'IMPORTED', 'FAILED', 'STALE');--> statement-breakpoint
CREATE TABLE "catalog_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"mime_type" "catalog_asset_mime_type" NOT NULL,
	"byte_size" integer NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_assets_content_sha256_format" CHECK ("catalog_assets"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_assets_byte_size_non_negative" CHECK ("catalog_assets"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feishu_cargo_migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "feishu_cargo_migration_status" NOT NULL,
	"source_spreadsheet_hash" varchar(64) NOT NULL,
	"source_sheet_id" varchar(100) NOT NULL,
	"source_revision" integer NOT NULL,
	"source_digest" varchar(64) NOT NULL,
	"summary_json" jsonb NOT NULL,
	"normalized_rows_json" jsonb NOT NULL,
	"issues_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"temporary_assets_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_admin_user_id" uuid NOT NULL,
	"confirmed_by_admin_user_id" uuid,
	"imported_at" timestamp with time zone,
	"failure_code" varchar(80),
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_cargo_migration_runs_source_spreadsheet_hash_format" CHECK ("feishu_cargo_migration_runs"."source_spreadsheet_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feishu_cargo_migration_runs_source_digest_format" CHECK ("feishu_cargo_migration_runs"."source_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feishu_cargo_migration_runs_source_revision_non_negative" CHECK ("feishu_cargo_migration_runs"."source_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "feishu_cargo_migration_runs" ADD CONSTRAINT "feishu_cargo_migration_runs_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_cargo_migration_runs" ADD CONSTRAINT "feishu_cargo_migration_runs_confirmed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("confirmed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_assets_content_sha256_unique" ON "catalog_assets" USING btree ("content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_assets_storage_key_unique" ON "catalog_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_cargo_migration_runs_imported_once" ON "feishu_cargo_migration_runs" USING btree ("status") WHERE "feishu_cargo_migration_runs"."status" = 'IMPORTED';--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_image_asset_id_catalog_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."catalog_assets"("id") ON DELETE set null ON UPDATE no action;