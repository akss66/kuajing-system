DROP INDEX "order_lines_store_external_sub_order_unique";--> statement-breakpoint
DROP INDEX "order_shipments_store_external_order_unique";--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "deduplication_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "order_shipments" ADD COLUMN "deduplication_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "order_lines" AS line
SET "deduplication_active" = false
FROM "fulfillment_orders" AS fulfillment_order
WHERE line."order_id" = fulfillment_order."id"
  AND fulfillment_order."status" = 'CANCELLED';--> statement-breakpoint
UPDATE "order_shipments" AS shipment
SET "deduplication_active" = false
FROM "fulfillment_orders" AS fulfillment_order
WHERE shipment."order_id" = fulfillment_order."id"
  AND fulfillment_order."status" = 'CANCELLED';--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_store_external_sub_order_unique" ON "order_lines" USING btree ("store_id","external_sub_order_no") WHERE "order_lines"."external_sub_order_no" is not null and "order_lines"."deduplication_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "order_shipments_store_external_order_unique" ON "order_shipments" USING btree ("store_id","external_order_no") WHERE "order_shipments"."deduplication_active" = true;--> statement-breakpoint
CREATE OR REPLACE FUNCTION release_cancelled_order_deduplication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE order_lines
    SET deduplication_active = false
    WHERE order_id = NEW.id;

    UPDATE order_shipments
    SET deduplication_active = false
    WHERE order_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER fulfillment_orders_release_cancelled_deduplication
AFTER UPDATE OF status ON fulfillment_orders
FOR EACH ROW
WHEN (NEW.status = 'CANCELLED')
EXECUTE FUNCTION release_cancelled_order_deduplication();
