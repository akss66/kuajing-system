import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { EncryptedSecret } from "@/modules/jifeng-connection/types";

import { adminUsers } from "./identity";

export const jifengConnectionStatus = pgEnum("jifeng_connection_status", [
  "DISCONNECTED",
  "AUTHORIZED",
  "RESOURCE_SELECTION_REQUIRED",
  "READY_DISABLED",
  "ENABLED",
  "REFRESH_REQUIRED",
  "ERROR",
]);

export const jifengAuthorizationResult = pgEnum(
  "jifeng_authorization_result",
  ["SUCCEEDED", "FAILED"],
);

export const jifengConnections = pgTable(
  "jifeng_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionKey: varchar("connection_key", { length: 32 })
      .notNull()
      .unique(),
    status: jifengConnectionStatus("status")
      .default("DISCONNECTED")
      .notNull(),
    accessTokenEncrypted: jsonb("access_token_encrypted").$type<EncryptedSecret>(),
    refreshTokenEncrypted: jsonb("refresh_token_encrypted").$type<EncryptedSecret>(),
    userId: varchar("user_id", { length: 160 }),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    warehouseCode: varchar("warehouse_code", { length: 160 }),
    warehouseName: varchar("warehouse_name", { length: 240 }),
    logisticsId: integer("logistics_id"),
    logisticsName: varchar("logistics_name", { length: 240 }),
    authorizedByAdminUserId: uuid("authorized_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    authorizedAt: timestamp("authorized_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastRefreshedAt: timestamp("last_refreshed_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastDiagnosticAt: timestamp("last_diagnostic_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorSummary: text("last_error_summary"),
    fulfillmentEnabledAt: timestamp("fulfillment_enabled_at", {
      mode: "date",
      withTimezone: true,
    }),
    fulfillmentEnabledByAdminUserId: uuid(
      "fulfillment_enabled_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "jifeng_connections_primary_key_check",
      sql`${table.connectionKey} = 'PRIMARY'`,
    ),
    check(
      "jifeng_connections_authorization_provenance_pair_check",
      sql`(${table.authorizedAt} is null) = (${table.authorizedByAdminUserId} is null)`,
    ),
    check(
      "jifeng_connections_enablement_provenance_pair_check",
      sql`(${table.fulfillmentEnabledAt} is null) = (${table.fulfillmentEnabledByAdminUserId} is null)`,
    ),
    check(
      "jifeng_connections_authorized_status_provenance_check",
      sql`${table.status} not in ('AUTHORIZED', 'RESOURCE_SELECTION_REQUIRED', 'READY_DISABLED', 'ENABLED', 'REFRESH_REQUIRED') or (${table.authorizedAt} is not null and ${table.authorizedByAdminUserId} is not null)`,
    ),
    check(
      "jifeng_connections_enabled_status_provenance_check",
      sql`${table.status} <> 'ENABLED' or (${table.authorizedAt} is not null and ${table.authorizedByAdminUserId} is not null and ${table.fulfillmentEnabledAt} is not null and ${table.fulfillmentEnabledByAdminUserId} is not null)`,
    ),
  ],
);

export const jifengAuthorizationAttempts = pgTable(
  "jifeng_authorization_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    result: jifengAuthorizationResult("result").notNull(),
    errorCategory: varchar("error_category", { length: 80 }),
    attemptedAt: timestamp("attempted_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
);
