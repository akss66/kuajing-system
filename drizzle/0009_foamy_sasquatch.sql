CREATE INDEX "fulfillment_orders_status_submitted_index" ON "fulfillment_orders" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "order_shipments_kind_shipped_index" ON "order_shipments" USING btree ("kind","shipped_at");--> statement-breakpoint
CREATE INDEX "payment_claims_status_reviewed_index" ON "payment_claims" USING btree ("status","reviewed_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_created_index" ON "wallet_transactions" USING btree ("created_at");