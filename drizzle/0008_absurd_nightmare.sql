CREATE TYPE "public"."notification_severity" AS ENUM('INFO', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('UNREAD', 'READ', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "system_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(80) NOT NULL,
	"severity" "notification_severity" NOT NULL,
	"status" "notification_status" DEFAULT 'UNREAD' NOT NULL,
	"title" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"entity_type" varchar(80),
	"entity_id" varchar(160),
	"deduplication_key" varchar(255) NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_notifications_occurrence_positive" CHECK ("system_notifications"."occurrence_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "system_notifications_deduplication_unique" ON "system_notifications" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "system_notifications_status_last_index" ON "system_notifications" USING btree ("status","last_occurred_at");