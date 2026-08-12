CREATE TABLE "bulk_submission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"draft_id" uuid NOT NULL,
	"result_json" jsonb,
	"settlement_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_submission_requests_payload_digest_format" CHECK ("bulk_submission_requests"."payload_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "bulk_submission_requests" ADD CONSTRAINT "bulk_submission_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_submission_requests" ADD CONSTRAINT "bulk_submission_requests_draft_customer_fk" FOREIGN KEY ("draft_id","customer_id") REFERENCES "public"."bulk_import_drafts"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_submission_requests" ADD CONSTRAINT "bulk_submission_requests_settlement_customer_fk" FOREIGN KEY ("settlement_batch_id","customer_id") REFERENCES "public"."settlement_batches"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_submission_requests_customer_key_unique" ON "bulk_submission_requests" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bulk_submission_requests_draft_created_index" ON "bulk_submission_requests" USING btree ("draft_id","created_at");