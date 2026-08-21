ALTER TABLE "order_shipments" ADD COLUMN "shipping_fee_fen" integer;--> statement-breakpoint
UPDATE "order_shipments"
SET "shipping_fee_fen" = CASE
  WHEN "kind" = 'REPLACEMENT' THEN 0
  ELSE 1300
END;--> statement-breakpoint
ALTER TABLE "order_shipments" ALTER COLUMN "shipping_fee_fen" SET DEFAULT 1300;--> statement-breakpoint
ALTER TABLE "order_shipments" ALTER COLUMN "shipping_fee_fen" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD CONSTRAINT "order_shipments_shipping_fee_non_negative" CHECK ("order_shipments"."shipping_fee_fen" >= 0);
