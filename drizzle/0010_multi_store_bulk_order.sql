CREATE TYPE "public"."bulk_import_draft_status" AS ENUM('DRAFT', 'PARTIALLY_SUBMITTED', 'COMPLETED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."settlement_batch_status" AS ENUM('PENDING_PAYMENT', 'PAYMENT_REPORTED', 'PAID', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."settlement_payment_claim_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."wallet_hold_status" AS ENUM('ACTIVE', 'CONSUMED', 'RELEASED');--> statement-breakpoint
ALTER TYPE "public"."fulfillment_payment_mode" ADD VALUE 'MIXED';--> statement-breakpoint
CREATE TABLE "bulk_import_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "bulk_import_draft_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_import_drafts_id_customer_unique" UNIQUE("id","customer_id"),
	CONSTRAINT "bulk_import_drafts_version_non_negative" CHECK ("bulk_import_drafts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bulk_import_store_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "order_import_status" DEFAULT 'PREVIEW' NOT NULL,
	"error_summary" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_import_store_groups_id_store_customer_unique" UNIQUE("id","store_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_order_import_batches" (
	"order_id" uuid NOT NULL,
	"import_batch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_order_import_batches_pk" PRIMARY KEY("order_id","import_batch_id")
);
--> statement-breakpoint
CREATE TABLE "settlement_batch_orders" (
	"settlement_batch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"total_amount_fen" integer NOT NULL,
	"wallet_amount_fen" integer NOT NULL,
	"offline_amount_fen" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_batch_orders_pk" PRIMARY KEY("settlement_batch_id","order_id"),
	CONSTRAINT "settlement_batch_orders_total_positive" CHECK ("settlement_batch_orders"."total_amount_fen" > 0),
	CONSTRAINT "settlement_batch_orders_allocations_non_negative" CHECK ("settlement_batch_orders"."wallet_amount_fen" >= 0 and "settlement_batch_orders"."offline_amount_fen" >= 0),
	CONSTRAINT "settlement_batch_orders_allocation_equation" CHECK ("settlement_batch_orders"."total_amount_fen" = "settlement_batch_orders"."wallet_amount_fen" + "settlement_batch_orders"."offline_amount_fen")
);
--> statement-breakpoint
CREATE TABLE "settlement_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" varchar(64) NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "settlement_batch_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"status_reason" text,
	"total_amount_fen" integer NOT NULL,
	"wallet_amount_fen" integer NOT NULL,
	"offline_amount_fen" integer NOT NULL,
	"payment_due_at" timestamp with time zone NOT NULL,
	"payment_reported_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"idempotency_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_batches_id_customer_unique" UNIQUE("id","customer_id"),
	CONSTRAINT "settlement_batches_total_positive" CHECK ("settlement_batches"."total_amount_fen" > 0),
	CONSTRAINT "settlement_batches_allocations_non_negative" CHECK ("settlement_batches"."wallet_amount_fen" >= 0 and "settlement_batches"."offline_amount_fen" >= 0),
	CONSTRAINT "settlement_batches_allocation_equation" CHECK ("settlement_batches"."total_amount_fen" = "settlement_batches"."wallet_amount_fen" + "settlement_batches"."offline_amount_fen"),
	CONSTRAINT "settlement_batches_terminal_reason_required" CHECK ("settlement_batches"."status" not in ('REJECTED', 'WITHDRAWN', 'CANCELLED', 'EXPIRED') or nullif(trim("settlement_batches"."status_reason"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "settlement_payment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_batch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "settlement_payment_claim_status" DEFAULT 'PENDING' NOT NULL,
	"amount_fen" integer NOT NULL,
	"note" text,
	"rejection_reason" text,
	"withdrawal_reason" text,
	"reviewed_by_admin_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_payment_claims_amount_positive" CHECK ("settlement_payment_claims"."amount_fen" > 0),
	CONSTRAINT "settlement_payment_claims_review_details_required" CHECK ("settlement_payment_claims"."status" not in ('APPROVED', 'REJECTED') or ("settlement_payment_claims"."reviewed_at" is not null and "settlement_payment_claims"."reviewed_by_admin_user_id" is not null)),
	CONSTRAINT "settlement_payment_claims_rejection_reason_required" CHECK ("settlement_payment_claims"."status" <> 'REJECTED' or nullif(trim("settlement_payment_claims"."rejection_reason"), '') is not null),
	CONSTRAINT "settlement_payment_claims_withdrawal_details_required" CHECK ("settlement_payment_claims"."status" <> 'WITHDRAWN' or ("settlement_payment_claims"."withdrawn_at" is not null and nullif(trim("settlement_payment_claims"."withdrawal_reason"), '') is not null))
);
--> statement-breakpoint
CREATE TABLE "wallet_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"settlement_batch_id" uuid NOT NULL,
	"amount_fen" integer NOT NULL,
	"status" "wallet_hold_status" DEFAULT 'ACTIVE' NOT NULL,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_holds_amount_positive" CHECK ("wallet_holds"."amount_fen" > 0),
	CONSTRAINT "wallet_holds_consumed_at_required" CHECK ("wallet_holds"."status" <> 'CONSUMED' or "wallet_holds"."consumed_at" is not null),
	CONSTRAINT "wallet_holds_release_details_required" CHECK ("wallet_holds"."status" <> 'RELEASED' or ("wallet_holds"."released_at" is not null and nullif(trim("wallet_holds"."release_reason"), '') is not null))
);
--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD COLUMN "store_group_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_import_drafts" ADD CONSTRAINT "bulk_import_drafts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_import_store_groups" ADD CONSTRAINT "bulk_import_store_groups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_import_store_groups" ADD CONSTRAINT "bulk_import_store_groups_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_import_store_groups" ADD CONSTRAINT "bulk_import_store_groups_draft_customer_fk" FOREIGN KEY ("draft_id","customer_id") REFERENCES "public"."bulk_import_drafts"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_import_store_groups" ADD CONSTRAINT "bulk_import_store_groups_store_customer_fk" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."stores"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_order_import_batches" ADD CONSTRAINT "fulfillment_order_import_batches_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_order_import_batches" ADD CONSTRAINT "fulfillment_order_import_batches_import_batch_id_order_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."order_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batch_orders" ADD CONSTRAINT "settlement_batch_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batch_orders" ADD CONSTRAINT "settlement_batch_orders_batch_customer_fk" FOREIGN KEY ("settlement_batch_id","customer_id") REFERENCES "public"."settlement_batches"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batch_orders" ADD CONSTRAINT "settlement_batch_orders_order_customer_fk" FOREIGN KEY ("order_id","customer_id") REFERENCES "public"."fulfillment_orders"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_payment_claims" ADD CONSTRAINT "settlement_payment_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_payment_claims" ADD CONSTRAINT "settlement_payment_claims_reviewed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_payment_claims" ADD CONSTRAINT "settlement_payment_claims_batch_customer_fk" FOREIGN KEY ("settlement_batch_id","customer_id") REFERENCES "public"."settlement_batches"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_batch_customer_fk" FOREIGN KEY ("settlement_batch_id","customer_id") REFERENCES "public"."settlement_batches"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_import_drafts_customer_status_index" ON "bulk_import_drafts" USING btree ("customer_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_import_store_groups_draft_store_unique" ON "bulk_import_store_groups" USING btree ("draft_id","store_id");--> statement-breakpoint
CREATE INDEX "bulk_import_store_groups_draft_status_index" ON "bulk_import_store_groups" USING btree ("draft_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_order_import_batches_import_batch_unique" ON "fulfillment_order_import_batches" USING btree ("import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batch_orders_order_unique" ON "settlement_batch_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "settlement_batch_orders_batch_index" ON "settlement_batch_orders" USING btree ("settlement_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batches_batch_number_unique" ON "settlement_batches" USING btree ("batch_number");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_batches_idempotency_key_unique" ON "settlement_batches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "settlement_batches_customer_created_index" ON "settlement_batches" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "settlement_batches_status_due_index" ON "settlement_batches" USING btree ("status","payment_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_payment_claims_batch_pending_unique" ON "settlement_payment_claims" USING btree ("settlement_batch_id") WHERE "settlement_payment_claims"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "settlement_payment_claims_status_created_index" ON "settlement_payment_claims" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "settlement_payment_claims_status_reviewed_index" ON "settlement_payment_claims" USING btree ("status","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_holds_settlement_active_unique" ON "wallet_holds" USING btree ("settlement_batch_id") WHERE "wallet_holds"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "wallet_holds_customer_status_index" ON "wallet_holds" USING btree ("customer_id","status");--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD CONSTRAINT "order_import_batches_store_group_fk" FOREIGN KEY ("store_group_id","store_id","customer_id") REFERENCES "public"."bulk_import_store_groups"("id","store_id","customer_id") ON DELETE restrict ON UPDATE no action;