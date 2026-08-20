ALTER TABLE "shipment_fulfillments" ADD COLUMN "last_status_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD COLUMN "last_status_poll_error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD COLUMN "last_status_poll_error_message" text;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD COLUMN "status_poll_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD COLUMN "status_poll_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD COLUMN "status_poll_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_fulfillments" ADD CONSTRAINT "shipment_fulfillments_status_poll_failure_count_non_negative" CHECK ("shipment_fulfillments"."status_poll_failure_count" >= 0);
