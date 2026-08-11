CREATE TYPE "public"."sku_sale_status" AS ENUM('SELLABLE', 'NOT_SELLABLE');--> statement-breakpoint
CREATE TABLE "customer_sku_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"unit_price_fen" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sku_prices_unit_price_non_negative" CHECK ("customer_sku_prices"."unit_price_fen" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sku_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"external_sku" varchar(160) NOT NULL,
	"sku_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku_code" varchar(80) NOT NULL,
	"name" varchar(200) NOT NULL,
	"image_url" text,
	"product_url" text,
	"specification" varchar(240),
	"color" varchar(160),
	"combination" varchar(160),
	"weight_grams" integer,
	"default_unit_price_fen" integer NOT NULL,
	"declaration_unit_price_fen" integer,
	"sale_status" "sku_sale_status" DEFAULT 'SELLABLE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_sku_code_unique" UNIQUE("sku_code"),
	CONSTRAINT "skus_weight_non_negative" CHECK ("skus"."weight_grams" >= 0),
	CONSTRAINT "skus_default_price_non_negative" CHECK ("skus"."default_unit_price_fen" >= 0),
	CONSTRAINT "skus_declaration_price_non_negative" CHECK ("skus"."declaration_unit_price_fen" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ADD CONSTRAINT "customer_sku_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sku_prices" ADD CONSTRAINT "customer_sku_prices_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_aliases" ADD CONSTRAINT "sku_aliases_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_aliases" ADD CONSTRAINT "sku_aliases_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_sku_prices_customer_sku_unique" ON "customer_sku_prices" USING btree ("customer_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_aliases_store_external_unique" ON "sku_aliases" USING btree ("store_id","external_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_aliases_global_external_unique" ON "sku_aliases" USING btree ("external_sku") WHERE "sku_aliases"."store_id" is null;