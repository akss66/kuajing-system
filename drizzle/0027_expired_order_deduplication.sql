UPDATE "order_lines" AS line
SET "deduplication_active" = false
FROM "fulfillment_orders" AS fulfillment_order
WHERE line."order_id" = fulfillment_order."id"
  AND fulfillment_order."status" IN ('CANCELLED', 'EXPIRED');--> statement-breakpoint
UPDATE "order_shipments" AS shipment
SET "deduplication_active" = false
FROM "fulfillment_orders" AS fulfillment_order
WHERE shipment."order_id" = fulfillment_order."id"
  AND fulfillment_order."status" IN ('CANCELLED', 'EXPIRED');--> statement-breakpoint
DROP TRIGGER IF EXISTS fulfillment_orders_release_cancelled_deduplication ON fulfillment_orders;--> statement-breakpoint
DROP FUNCTION IF EXISTS release_cancelled_order_deduplication();--> statement-breakpoint
CREATE OR REPLACE FUNCTION release_terminal_order_deduplication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('CANCELLED', 'EXPIRED') AND OLD.status IS DISTINCT FROM NEW.status THEN
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
CREATE TRIGGER fulfillment_orders_release_terminal_deduplication
AFTER UPDATE OF status ON fulfillment_orders
FOR EACH ROW
WHEN (NEW.status IN ('CANCELLED', 'EXPIRED'))
EXECUTE FUNCTION release_terminal_order_deduplication();
