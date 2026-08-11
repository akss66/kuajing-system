import {
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const accountStatus = pgEnum("account_status", ["ACTIVE", "DISABLED"]);

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  contactName: varchar("contact_name", { length: 120 }),
  contactWechat: varchar("contact_wechat", { length: 120 }),
  status: accountStatus("status").default("ACTIVE").notNull(),
  ...timestamps,
});

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 160 }).notNull(),
    platform: varchar("platform", { length: 40 }).default("TEMU").notNull(),
    externalStoreCode: varchar("external_store_code", { length: 120 }),
    status: accountStatus("status").default("ACTIVE").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("stores_customer_name_unique").on(table.customerId, table.name)],
);
