import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const notificationSeverity = pgEnum("notification_severity", [
  "INFO",
  "WARNING",
  "ERROR",
]);

export const notificationStatus = pgEnum("notification_status", [
  "UNREAD",
  "READ",
  "RESOLVED",
]);

export const systemNotifications = pgTable(
  "system_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 80 }).notNull(),
    severity: notificationSeverity("severity").notNull(),
    status: notificationStatus("status").default("UNREAD").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    message: text("message").notNull(),
    entityType: varchar("entity_type", { length: 80 }),
    entityId: varchar("entity_id", { length: 160 }),
    deduplicationKey: varchar("deduplication_key", { length: 255 }).notNull(),
    occurrenceCount: integer("occurrence_count").default(1).notNull(),
    firstOccurredAt: timestamp("first_occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    lastOccurredAt: timestamp("last_occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("system_notifications_deduplication_unique").on(
      table.deduplicationKey,
    ),
    check(
      "system_notifications_occurrence_positive",
      sql`${table.occurrenceCount} > 0`,
    ),
    index("system_notifications_status_last_index").on(
      table.status,
      table.lastOccurredAt,
    ),
  ],
);
