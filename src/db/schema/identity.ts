import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { accountStatus, customers } from "./customers";

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  loginIdentifier: varchar("login_identifier", { length: 320 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  status: accountStatus("status").default("ACTIVE").notNull(),
  ...timestamps,
});

export const customerUsers = pgTable("customer_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "restrict" }),
  loginIdentifier: varchar("login_identifier", { length: 320 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  status: accountStatus("status").default("ACTIVE").notNull(),
  ...timestamps,
});
