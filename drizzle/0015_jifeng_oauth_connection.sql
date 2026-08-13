CREATE TYPE "public"."jifeng_authorization_result" AS ENUM('SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."jifeng_connection_status" AS ENUM('DISCONNECTED', 'AUTHORIZED', 'RESOURCE_SELECTION_REQUIRED', 'READY_DISABLED', 'ENABLED', 'REFRESH_REQUIRED', 'ERROR');--> statement-breakpoint
CREATE TABLE "jifeng_authorization_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"result" "jifeng_authorization_result" NOT NULL,
	"error_category" varchar(80),
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jifeng_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_key" varchar(32) NOT NULL,
	"status" "jifeng_connection_status" DEFAULT 'DISCONNECTED' NOT NULL,
	"access_token_encrypted" jsonb,
	"refresh_token_encrypted" jsonb,
	"user_id" varchar(160),
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"warehouse_code" varchar(160),
	"warehouse_name" varchar(240),
	"logistics_id" integer,
	"logistics_name" varchar(240),
	"authorized_by_admin_user_id" uuid,
	"authorized_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_diagnostic_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_summary" text,
	"fulfillment_enabled_at" timestamp with time zone,
	"fulfillment_enabled_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jifeng_connections_connection_key_unique" UNIQUE("connection_key"),
	CONSTRAINT "jifeng_connections_primary_key_check" CHECK ("jifeng_connections"."connection_key" = 'PRIMARY'),
	CONSTRAINT "jifeng_connections_authorization_provenance_pair_check" CHECK (("jifeng_connections"."authorized_at" is null) = ("jifeng_connections"."authorized_by_admin_user_id" is null)),
	CONSTRAINT "jifeng_connections_enablement_provenance_pair_check" CHECK (("jifeng_connections"."fulfillment_enabled_at" is null) = ("jifeng_connections"."fulfillment_enabled_by_admin_user_id" is null)),
	CONSTRAINT "jifeng_connections_authorized_status_provenance_check" CHECK ("jifeng_connections"."status" not in ('AUTHORIZED', 'RESOURCE_SELECTION_REQUIRED', 'READY_DISABLED', 'ENABLED', 'REFRESH_REQUIRED') or ("jifeng_connections"."authorized_at" is not null and "jifeng_connections"."authorized_by_admin_user_id" is not null)),
	CONSTRAINT "jifeng_connections_enabled_status_provenance_check" CHECK ("jifeng_connections"."status" <> 'ENABLED' or ("jifeng_connections"."authorized_at" is not null and "jifeng_connections"."authorized_by_admin_user_id" is not null and "jifeng_connections"."fulfillment_enabled_at" is not null and "jifeng_connections"."fulfillment_enabled_by_admin_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "jifeng_authorization_attempts" ADD CONSTRAINT "jifeng_authorization_attempts_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jifeng_connections" ADD CONSTRAINT "jifeng_connections_authorized_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("authorized_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jifeng_connections" ADD CONSTRAINT "jifeng_connections_fulfillment_enabled_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("fulfillment_enabled_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;
