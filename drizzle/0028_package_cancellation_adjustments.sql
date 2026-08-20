CREATE TYPE "public"."fulfillment_order_cancellation_state" AS ENUM('NONE', 'PARTIAL', 'ALL');--> statement-breakpoint
CREATE TYPE "public"."shipment_cancellation_adjustment_status" AS ENUM('NOT_PAID', 'PENDING_OFFLINE', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "shipment_cancellation_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"merchandise_amount_fen" integer NOT NULL,
	"shipping_fee_fen" integer NOT NULL,
	"total_amount_fen" integer NOT NULL,
	"wallet_amount_fen" integer NOT NULL,
	"offline_amount_fen" integer NOT NULL,
	"status" "shipment_cancellation_adjustment_status" NOT NULL,
	"reason" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"offline_completed_at" timestamp with time zone,
	"offline_completed_by_admin_user_id" uuid,
	"offline_completion_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_cancellation_adjustments_amounts_positive" CHECK ("shipment_cancellation_adjustments"."merchandise_amount_fen" >= 0 and "shipment_cancellation_adjustments"."shipping_fee_fen" >= 0 and "shipment_cancellation_adjustments"."total_amount_fen" > 0),
	CONSTRAINT "shipment_cancellation_adjustments_total_equation" CHECK ("shipment_cancellation_adjustments"."total_amount_fen" = "shipment_cancellation_adjustments"."merchandise_amount_fen" + "shipment_cancellation_adjustments"."shipping_fee_fen"),
	CONSTRAINT "shipment_cancellation_adjustments_payment_allocation" CHECK ("shipment_cancellation_adjustments"."wallet_amount_fen" >= 0 and "shipment_cancellation_adjustments"."offline_amount_fen" >= 0 and (("shipment_cancellation_adjustments"."status" = 'NOT_PAID' and "shipment_cancellation_adjustments"."wallet_amount_fen" = 0 and "shipment_cancellation_adjustments"."offline_amount_fen" = 0) or ("shipment_cancellation_adjustments"."status" <> 'NOT_PAID' and "shipment_cancellation_adjustments"."total_amount_fen" = "shipment_cancellation_adjustments"."wallet_amount_fen" + "shipment_cancellation_adjustments"."offline_amount_fen"))),
	CONSTRAINT "shipment_cancellation_adjustments_offline_state" CHECK (("shipment_cancellation_adjustments"."status" = 'NOT_PAID' and "shipment_cancellation_adjustments"."offline_completed_at" is null and "shipment_cancellation_adjustments"."offline_completed_by_admin_user_id" is null) or ("shipment_cancellation_adjustments"."offline_amount_fen" = 0 and "shipment_cancellation_adjustments"."status" = 'COMPLETED' and "shipment_cancellation_adjustments"."offline_completed_at" is null and "shipment_cancellation_adjustments"."offline_completed_by_admin_user_id" is null) or ("shipment_cancellation_adjustments"."offline_amount_fen" > 0 and (("shipment_cancellation_adjustments"."status" = 'PENDING_OFFLINE' and "shipment_cancellation_adjustments"."offline_completed_at" is null and "shipment_cancellation_adjustments"."offline_completed_by_admin_user_id" is null) or ("shipment_cancellation_adjustments"."status" = 'COMPLETED' and "shipment_cancellation_adjustments"."offline_completed_at" is not null and "shipment_cancellation_adjustments"."offline_completed_by_admin_user_id" is not null))))
);
--> statement-breakpoint
DROP INDEX "wallet_transactions_order_refund_unique";--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD COLUMN "cancellation_state" "fulfillment_order_cancellation_state" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
UPDATE "fulfillment_orders"
SET "cancellation_state" = 'ALL'
WHERE "status" = 'CANCELLED';--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_cancellation_adjustments" ADD CONSTRAINT "shipment_cancellation_adjustments_offline_completed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("offline_completed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cancellation_adjustments" ADD CONSTRAINT "shipment_cancellation_adjustments_shipment_order_fk" FOREIGN KEY ("shipment_id","order_id") REFERENCES "public"."order_shipments"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_cancellation_adjustments" ADD CONSTRAINT "shipment_cancellation_adjustments_order_customer_fk" FOREIGN KEY ("order_id","customer_id") REFERENCES "public"."fulfillment_orders"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_cancellation_adjustments_shipment_unique" ON "shipment_cancellation_adjustments" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_cancellation_adjustments_order_created_index" ON "shipment_cancellation_adjustments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "shipment_cancellation_adjustments_status_created_index" ON "shipment_cancellation_adjustments" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_shipment_order_fk" FOREIGN KEY ("shipment_id","order_id") REFERENCES "public"."order_shipments"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_shipment_refund_unique" ON "wallet_transactions" USING btree ("shipment_id") WHERE "wallet_transactions"."transaction_type" = 'ORDER_REFUND' and "wallet_transactions"."shipment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_order_refund_unique" ON "wallet_transactions" USING btree ("order_id") WHERE "wallet_transactions"."transaction_type" = 'ORDER_REFUND' and "wallet_transactions"."shipment_id" is null;--> statement-breakpoint
ALTER TABLE "fulfillment_orders" ADD CONSTRAINT "fulfillment_orders_cancellation_state_matches_status" CHECK (("fulfillment_orders"."cancellation_state" = 'ALL' and "fulfillment_orders"."status" = 'CANCELLED') or ("fulfillment_orders"."cancellation_state" <> 'ALL' and "fulfillment_orders"."status" <> 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_shipment_refund_only" CHECK ("wallet_transactions"."shipment_id" is null or "wallet_transactions"."transaction_type" = 'ORDER_REFUND');
