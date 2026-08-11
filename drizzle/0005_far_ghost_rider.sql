CREATE TYPE "public"."fulfillment_order_source" AS ENUM('TEMU_EXCEL', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_order_status" AS ENUM('PENDING_PAYMENT', 'PAID_PENDING_FULFILLMENT', 'FULFILLING', 'SHIPPED', 'FULFILLMENT_EXCEPTION', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_payment_mode" AS ENUM('WALLET', 'DIRECT_OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."order_import_row_status" AS ENUM('READY', 'DUPLICATE', 'UNKNOWN_SKU', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."order_import_status" AS ENUM('PREVIEW', 'SUBMITTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."payment_claim_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."shipment_kind" AS ENUM('NORMAL', 'REPLACEMENT');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_type" AS ENUM('ADMIN_CREDIT', 'ADMIN_DEBIT', 'ORDER_DEBIT', 'ORDER_REFUND');--> statement-breakpoint
CREATE TABLE "fulfillment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"customer_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"source" "fulfillment_order_source" DEFAULT 'TEMU_EXCEL' NOT NULL,
	"status" "fulfillment_order_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"payment_mode" "fulfillment_payment_mode",
	"total_amount_fen" integer NOT NULL,
	"total_package_count" integer NOT NULL,
	"total_quantity" integer NOT NULL,
	"lock_expires_at" timestamp with time zone,
	"payment_declared_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "fulfillment_orders_amount_non_negative" CHECK ("fulfillment_orders"."total_amount_fen" >= 0),
	CONSTRAINT "fulfillment_orders_package_count_non_negative" CHECK ("fulfillment_orders"."total_package_count" >= 0),
	CONSTRAINT "fulfillment_orders_quantity_positive" CHECK ("fulfillment_orders"."total_quantity" > 0),
	CONSTRAINT "fulfillment_orders_cancel_reason_required" CHECK ("fulfillment_orders"."status" <> 'CANCELLED' or nullif(trim("fulfillment_orders"."cancel_reason"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "order_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "order_import_status" DEFAULT 'PREVIEW' NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"file_sha256" varchar(64) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"ready_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"unknown_sku_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_batches_file_size_non_negative" CHECK ("order_import_batches"."file_size_bytes" >= 0),
	CONSTRAINT "order_import_batches_counts_non_negative" CHECK ("order_import_batches"."total_rows" >= 0 and "order_import_batches"."ready_rows" >= 0 and "order_import_batches"."duplicate_rows" >= 0 and "order_import_batches"."unknown_sku_rows" >= 0 and "order_import_batches"."invalid_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"status" "order_import_row_status" NOT NULL,
	"external_order_no" varchar(160),
	"external_sub_order_no" varchar(160),
	"external_sku" varchar(160),
	"product_name" text,
	"product_attributes" text,
	"quantity" integer,
	"resolved_sku_id" uuid,
	"recipient_payload_encrypted" text,
	"error_code" varchar(80),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_import_rows_row_number_positive" CHECK ("order_import_rows"."row_number" > 0),
	CONSTRAINT "order_import_rows_quantity_positive_when_present" CHECK ("order_import_rows"."quantity" is null or "order_import_rows"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shipment_id" uuid,
	"store_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"external_sub_order_no" varchar(160),
	"external_sku" varchar(160),
	"sku_code_snapshot" varchar(80) NOT NULL,
	"sku_name_snapshot" varchar(200) NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_fen" integer NOT NULL,
	"line_amount_fen" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_quantity_positive" CHECK ("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_unit_price_non_negative" CHECK ("order_lines"."unit_price_fen" >= 0),
	CONSTRAINT "order_lines_amount_matches_quantity" CHECK ("order_lines"."line_amount_fen" = "order_lines"."quantity" * "order_lines"."unit_price_fen")
);
--> statement-breakpoint
CREATE TABLE "order_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "shipment_kind" DEFAULT 'NORMAL' NOT NULL,
	"external_order_no" varchar(160) NOT NULL,
	"recipient_payload_encrypted" text NOT NULL,
	"country_code" varchar(2) DEFAULT 'CA' NOT NULL,
	"carrier_code" varchar(40) DEFAULT 'CANADA_POST' NOT NULL,
	"tracking_number" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "payment_claim_status" DEFAULT 'PENDING' NOT NULL,
	"amount_fen" integer NOT NULL,
	"note" text,
	"rejection_reason" text,
	"reviewed_by_admin_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_claims_amount_positive" CHECK ("payment_claims"."amount_fen" > 0),
	CONSTRAINT "payment_claims_rejection_reason_required" CHECK ("payment_claims"."status" <> 'REJECTED' or nullif(trim("payment_claims"."rejection_reason"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"balance_fen" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_balance_non_negative" CHECK ("wallet_accounts"."balance_fen" >= 0),
	CONSTRAINT "wallet_accounts_version_non_negative" CHECK ("wallet_accounts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"transaction_type" "wallet_transaction_type" NOT NULL,
	"before_balance_fen" integer NOT NULL,
	"delta_fen" integer NOT NULL,
	"after_balance_fen" integer NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_balances_non_negative" CHECK ("wallet_transactions"."before_balance_fen" >= 0 and "wallet_transactions"."after_balance_fen" >= 0),
	CONSTRAINT "wallet_transactions_delta_non_zero" CHECK ("wallet_transactions"."delta_fen" <> 0),
	CONSTRAINT "wallet_transactions_balance_equation" CHECK ("wallet_transactions"."after_balance_fen" = "wallet_transactions"."before_balance_fen" + "wallet_transactions"."delta_fen")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stores_id_customer_unique" ON "stores" USING btree ("id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_orders_id_store_unique" ON "fulfillment_orders" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_shipments_id_order_unique" ON "order_shipments" USING btree ("id","order_id");--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_import_batch_id_order_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."order_import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_store_customer_fk" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."stores"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD CONSTRAINT "order_import_batches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD CONSTRAINT "order_import_batches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_batches" ADD CONSTRAINT "order_import_batches_store_customer_fk" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."stores"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_batch_id_order_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."order_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_rows" ADD CONSTRAINT "order_import_rows_resolved_sku_id_skus_id_fk" FOREIGN KEY ("resolved_sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_shipment_id_order_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."order_shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_store_fk" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."fulfillment_orders"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_shipment_order_fk" FOREIGN KEY ("shipment_id","order_id") REFERENCES "public"."order_shipments"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_order_store_fk" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."fulfillment_orders"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_reviewed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_order_id_fulfillment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fulfillment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_orders_import_batch_unique" ON "fulfillment_orders" USING btree ("import_batch_id") WHERE "fulfillment_orders"."import_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "fulfillment_orders_customer_created_index" ON "fulfillment_orders" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "fulfillment_orders_status_lock_index" ON "fulfillment_orders" USING btree ("status","lock_expires_at");--> statement-breakpoint
CREATE INDEX "order_import_batches_customer_created_index" ON "order_import_batches" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "order_import_batches_store_hash_index" ON "order_import_batches" USING btree ("store_id","file_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "order_import_rows_batch_row_unique" ON "order_import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "order_import_rows_batch_status_index" ON "order_import_rows" USING btree ("batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_store_external_sub_order_unique" ON "order_lines" USING btree ("store_id","external_sub_order_no") WHERE "order_lines"."external_sub_order_no" is not null;--> statement-breakpoint
CREATE INDEX "order_lines_order_index" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_sku_index" ON "order_lines" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_shipments_store_external_order_unique" ON "order_shipments" USING btree ("store_id","external_order_no");--> statement-breakpoint
CREATE INDEX "order_shipments_order_index" ON "order_shipments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_order_pending_unique" ON "payment_claims" USING btree ("order_id") WHERE "payment_claims"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "payment_claims_status_created_index" ON "payment_claims" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_order_debit_unique" ON "wallet_transactions" USING btree ("order_id") WHERE "wallet_transactions"."transaction_type" = 'ORDER_DEBIT';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_order_refund_unique" ON "wallet_transactions" USING btree ("order_id") WHERE "wallet_transactions"."transaction_type" = 'ORDER_REFUND';--> statement-breakpoint
CREATE INDEX "wallet_transactions_customer_created_index" ON "wallet_transactions" USING btree ("customer_id","created_at");
