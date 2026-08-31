DROP INDEX "order_lines_store_external_sub_order_unique";--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "line_position" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_store_external_sub_order_unique" ON "order_lines" USING btree ("store_id","external_sub_order_no","line_position") WHERE "order_lines"."external_sub_order_no" is not null and "order_lines"."deduplication_active" = true;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_position_positive" CHECK ("order_lines"."line_position" > 0);