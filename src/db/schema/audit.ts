import { jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const actorType = pgEnum("actor_type", ["ADMIN", "CUSTOMER", "SYSTEM"]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorType: actorType("actor_type").notNull(),
  actorId: uuid("actor_id"),
  action: varchar("action", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 120 }).notNull(),
  entityId: varchar("entity_id", { length: 160 }).notNull(),
  beforeJson: jsonb("before_json").$type<Record<string, unknown>>().notNull(),
  afterJson: jsonb("after_json").$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});
