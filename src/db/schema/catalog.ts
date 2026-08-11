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

export const skus = pgTable(
  "skus",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    skuCode: varchar("sku_code", { length: 80 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
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
