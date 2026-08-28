CREATE TYPE "public"."ai_sku_match_run_status" AS ENUM('PENDING', 'SUCCEEDED', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ai_sku_match_suggestion_decision" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'STALE');--> statement-breakpoint
ALTER TYPE "public"."import_sku_resolution_method" ADD VALUE 'AI_CONFIRMED' BEFORE 'CUSTOMER_SUPPLIED';--> statement-breakpoint
CREATE TABLE "ai_sku_match_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"model" varchar(80) NOT NULL,
	"prompt_version" varchar(40) NOT NULL,
	"status" "ai_sku_match_run_status" DEFAULT 'PENDING' NOT NULL,
	"row_count" integer NOT NULL,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"safe_error_code" varchar(80),
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_sku_match_runs_row_count_bounded" CHECK ("ai_sku_match_runs"."row_count" > 0 and "ai_sku_match_runs"."row_count" <= 20),
	CONSTRAINT "ai_sku_match_runs_suggestion_count_bounded" CHECK ("ai_sku_match_runs"."suggestion_count" >= 0 and "ai_sku_match_runs"."suggestion_count" <= "ai_sku_match_runs"."row_count" * 3),
	CONSTRAINT "ai_sku_match_runs_token_counts_non_negative" CHECK (("ai_sku_match_runs"."prompt_tokens" is null or "ai_sku_match_runs"."prompt_tokens" >= 0) and ("ai_sku_match_runs"."completion_tokens" is null or "ai_sku_match_runs"."completion_tokens" >= 0)),
	CONSTRAINT "ai_sku_match_runs_latency_non_negative" CHECK ("ai_sku_match_runs"."latency_ms" is null or "ai_sku_match_runs"."latency_ms" >= 0),
	CONSTRAINT "ai_sku_match_runs_completion_consistent" CHECK (("ai_sku_match_runs"."status" = 'PENDING' and "ai_sku_match_runs"."completed_at" is null) or ("ai_sku_match_runs"."status" <> 'PENDING' and "ai_sku_match_runs"."completed_at" is not null)),
	CONSTRAINT "ai_sku_match_runs_expiry_after_creation" CHECK ("ai_sku_match_runs"."expires_at" > "ai_sku_match_runs"."created_at")
);
--> statement-breakpoint
CREATE TABLE "ai_sku_match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"row_revision" integer NOT NULL,
	"prompt_version" varchar(40) NOT NULL,
	"input_fingerprint" varchar(64) NOT NULL,
	"candidates" jsonb NOT NULL,
	"decision" "ai_sku_match_suggestion_decision" DEFAULT 'PENDING' NOT NULL,
	"accepted_sku_id" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_sku_match_suggestions_revision_non_negative" CHECK ("ai_sku_match_suggestions"."row_revision" >= 0),
	CONSTRAINT "ai_sku_match_suggestions_fingerprint_format" CHECK ("ai_sku_match_suggestions"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_sku_match_suggestions_candidates_bounded" CHECK (jsonb_typeof("ai_sku_match_suggestions"."candidates") = 'array' and jsonb_array_length("ai_sku_match_suggestions"."candidates") between 1 and 3),
	CONSTRAINT "ai_sku_match_suggestions_decision_consistent" CHECK (("ai_sku_match_suggestions"."decision" = 'PENDING' and "ai_sku_match_suggestions"."accepted_sku_id" is null and "ai_sku_match_suggestions"."decided_at" is null) or ("ai_sku_match_suggestions"."decision" = 'ACCEPTED' and "ai_sku_match_suggestions"."accepted_sku_id" is not null and "ai_sku_match_suggestions"."decided_at" is not null) or ("ai_sku_match_suggestions"."decision" in ('REJECTED', 'STALE') and "ai_sku_match_suggestions"."accepted_sku_id" is null and "ai_sku_match_suggestions"."decided_at" is not null)),
	CONSTRAINT "ai_sku_match_suggestions_expiry_after_creation" CHECK ("ai_sku_match_suggestions"."expires_at" > "ai_sku_match_suggestions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "ai_sku_match_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sku_match_runs" ADD CONSTRAINT "ai_sku_match_runs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_runs" ADD CONSTRAINT "ai_sku_match_runs_batch_id_order_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."order_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_suggestions" ADD CONSTRAINT "ai_sku_match_suggestions_run_id_ai_sku_match_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_sku_match_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_suggestions" ADD CONSTRAINT "ai_sku_match_suggestions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_suggestions" ADD CONSTRAINT "ai_sku_match_suggestions_batch_id_order_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."order_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_suggestions" ADD CONSTRAINT "ai_sku_match_suggestions_row_id_order_import_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."order_import_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sku_match_suggestions" ADD CONSTRAINT "ai_sku_match_suggestions_accepted_sku_id_skus_id_fk" FOREIGN KEY ("accepted_sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_sku_match_runs_customer_created_index" ON "ai_sku_match_runs" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_sku_match_runs_expires_index" ON "ai_sku_match_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_sku_match_suggestions_pending_row_revision_unique" ON "ai_sku_match_suggestions" USING btree ("row_id","row_revision","prompt_version") WHERE "ai_sku_match_suggestions"."decision" = 'PENDING';--> statement-breakpoint
CREATE INDEX "ai_sku_match_suggestions_customer_batch_index" ON "ai_sku_match_suggestions" USING btree ("customer_id","batch_id","decision");--> statement-breakpoint
CREATE INDEX "ai_sku_match_suggestions_expires_index" ON "ai_sku_match_suggestions" USING btree ("expires_at");