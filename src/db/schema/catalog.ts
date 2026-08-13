import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { accountStatus, customers, stores } from "./customers";

export const skuSaleStatus = pgEnum("sku_sale_status", [
  "SELLABLE",
  "NOT_SELLABLE",
]);

export const catalogAssetMimeType = pgEnum("catalog_asset_mime_type", [
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  status: accountStatus("status").default("ACTIVE").notNull(),
  ...timestamps,
});

export const catalogAssets = pgTable(
  "catalog_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    mimeType: catalogAssetMimeType("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    originalFileName: varchar("original_file_name", { length: 255 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("catalog_assets_content_sha256_unique").on(table.contentSha256),
    uniqueIndex("catalog_assets_storage_key_unique").on(table.storageKey),
    check(
      "catalog_assets_content_sha256_format",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("catalog_assets_byte_size_non_negative", sql`${table.byteSize} >= 0`),
  ],
);

export const skus = pgTable(
  "skus",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    skuCode: varchar("sku_code", { length: 80 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    imageAssetId: uuid("image_asset_id").references(() => catalogAssets.id, {
      onDelete: "set null",
    }),
    imageUrl: text("image_url"),
    productUrl: text("product_url"),
    specification: varchar("specification", { length: 240 }),
    color: varchar("color", { length: 160 }),
    combination: varchar("combination", { length: 160 }),
    weightGrams: integer("weight_grams"),
    defaultUnitPriceFen: integer("default_unit_price_fen").notNull(),
    declarationUnitPriceFen: integer("declaration_unit_price_fen"),
    saleStatus: skuSaleStatus("sale_status").default("SELLABLE").notNull(),
    ...timestamps,
  },
  (table) => [
    check("skus_weight_non_negative", sql`${table.weightGrams} >= 0`),
    check(
      "skus_default_price_non_negative",
      sql`${table.defaultUnitPriceFen} >= 0`,
    ),
    check(
      "skus_declaration_price_non_negative",
      sql`${table.declarationUnitPriceFen} >= 0`,
    ),
  ],
);

export const customerSkuPrices = pgTable(
  "customer_sku_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id, { onDelete: "restrict" }),
    unitPriceFen: integer("unit_price_fen").notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("customer_sku_prices_customer_sku_unique").on(
      table.customerId,
      table.skuId,
    ),
    check(
      "customer_sku_prices_unit_price_non_negative",
      sql`${table.unitPriceFen} >= 0`,
    ),
  ],
);

export const skuAliases = pgTable(
  "sku_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id").references(() => stores.id, {
      onDelete: "restrict",
    }),
    externalSku: varchar("external_sku", { length: 160 }).notNull(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id, { onDelete: "restrict" }),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sku_aliases_store_external_unique").on(
      table.storeId,
      table.externalSku,
    ),
    uniqueIndex("sku_aliases_global_external_unique")
      .on(table.externalSku)
      .where(sql`${table.storeId} is null`),
  ],
);
