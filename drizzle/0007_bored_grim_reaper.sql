CREATE TYPE "public"."integration_attempt_outcome" AS ENUM('SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE');--> statement-breakpoint
CREATE TYPE "public"."integration_outbox_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."integration_target" AS ENUM('JIFENG', 'FEISHU_SHEET', 'FEISHU_BOT');--> statement-breakpoint
CREATE TYPE "public"."replacement_request_status" AS ENUM('PENDING_FULFILLMENT', 'FULFILLING', 'SHIPPED', 'EXCEPTION', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."shipment_fulfillment_status" AS ENUM('PENDING', 'SUBMITTING', 'SUBMITTED', 'FULFILLING', 'SHIPPED', 'EXCEPTION', 'CANCEL_PENDING', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "integration_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" "integration_attempt_outcome" NOT NULL,
	"error_code" varchar(80),
	"error_message" text,
	"response_metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_attempts_number_positive" CHECK ("integration_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "integration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" "integration_target" NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" varchar(160) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "integration_outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_outbox_attempt_count_non_negative" CHECK ("integration_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "replacement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"original_shipment_id" uuid NOT NULL,
	"replacement_shipment_id" uuid NOT NULL,
	"created_by_admin_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "replacement_request_status" DEFAULT 'PENDING_FULFILLMENT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replacement_requests_reason_required" CHECK (nullif(trim("replacement_requests"."reason"), '') is not null),
	CONSTRAINT "replacement_requests_distinct_shipments" CHECK ("replacement_requests"."original_shipment_id" <> "replacement_requests"."replacement_shipment_id")
);
--> statement-breakpoint
CREATE TABLE "shipment_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"provider" varchar(40) DEFAULT 'JIFENG' NOT NULL,
	"erp_no" varchar(100) NOT NULL,
	"status" "shipment_fulfillment_status" DEFAULT 'PENDING' NOT NULL,
	"external_order_no" varchar(160),
	"jifeng_status" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_fulfillments_provider_jifeng" CHECK ("shipment_fulfillments"."provider" = 'JIFENG'),
	CONSTRAINT "shipment_fulfillments_jifeng_status_range" CHECK ("shipment_fulfillments"."jifeng_status" is null or "shipment_fulfillments"."jifeng_status" between 1 and 11),
	CONSTRAINT "shipment_fulfillments_attempt_count_non_negative" CHECK ("shipment_fulfillments"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_shipments" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD COLUMN "logistics_fee_minor" integer;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD COLUMN "logistics_currency" varchar(3);--> statement-breakpoint
ALTER TABLE "integration_attempts" ADD CONSTRAINT "integration_attempts_outbox_event_id_integration_outbox_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."integration_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_original_order_fk" FOREIGN KEY ("original_shipment_id","order_id") REFERENCES "public"."order_shipments"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_replacement_order_fk" FOREIGN KEY ("replacement_shipment_id","order_id") REFERENCES "public"."order_shipments"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD CONSTRAINT "shipment_fulfillments_shipment_id_order_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."order_shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_attempts_event_number_unique" ON "integration_attempts" USING btree ("outbox_event_id","attempt_number");--> statement-breakpoint
CREATE INDEX "integration_attempts_event_index" ON "integration_attempts" USING btree ("outbox_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_outbox_idempotency_unique" ON "integration_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_outbox_pending_index" ON "integration_outbox" USING btree ("target","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replacement_requests_shipment_unique" ON "replacement_requests" USING btree ("replacement_shipment_id");--> statement-breakpoint
CREATE INDEX "replacement_requests_order_index" ON "replacement_requests" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_fulfillments_shipment_unique" ON "shipment_fulfillments" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_fulfillments_erp_no_unique" ON "shipment_fulfillments" USING btree ("erp_no");--> statement-breakpoint
CREATE INDEX "shipment_fulfillments_status_retry_index" ON "shipment_fulfillments" USING btree ("status","next_retry_at");--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_logistics_fee_non_negative" CHECK ("order_shipments"."logistics_fee_minor" is null or "order_shipments"."logistics_fee_minor" >= 0);--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_logistics_currency_format" CHECK ("order_shipments"."logistics_currency" is null or "order_shipments"."logistics_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_logistics_fee_currency_pair" CHECK ("order_shipments"."logistics_fee_minor" is null or "order_shipments"."logistics_currency" is not null);