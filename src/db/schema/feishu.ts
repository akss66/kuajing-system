import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type {
  MigrationIssue,
  MigrationSummary,
  NormalizedCargoRow,
  TemporaryAssetManifest,
} from "@/modules/feishu/cargo-types";

import { adminUsers } from "./identity";

export const feishuCargoMigrationStatus = pgEnum(
  "feishu_cargo_migration_status",
  [
    "PREFLIGHT_RUNNING",
    "PREFLIGHT_READY",
    "PREFLIGHT_BLOCKED",
    "IMPORTING",
    "IMPORTED",
    "FAILED",
    "STALE",
  ],
);

export const feishuCargoMigrationRuns = pgTable(
  "feishu_cargo_migration_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: feishuCargoMigrationStatus("status").notNull(),
    sourceSpreadsheetHash: varchar("source_spreadsheet_hash", {
      length: 64,
    }).notNull(),
    sourceSheetId: varchar("source_sheet_id", { length: 100 }).notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
    summaryJson: jsonb("summary_json").$type<MigrationSummary>().notNull(),
    normalizedRowsJson: jsonb("normalized_rows_json")
      .$type<NormalizedCargoRow[]>()
      .notNull(),
    issuesJson: jsonb("issues_json")
      .$type<MigrationIssue[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    temporaryAssetsJson: jsonb("temporary_assets_json")
      .$type<TemporaryAssetManifest[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    createdByAdminUserId: uuid("created_by_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    confirmedByAdminUserId: uuid("confirmed_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    importedAt: timestamp("imported_at", {
      mode: "date",
      withTimezone: true,
    }),
    failureCode: varchar("failure_code", { length: 80 }),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("feishu_cargo_migration_runs_imported_once")
      .on(table.status)
      .where(sql`${table.status} = 'IMPORTED'`),
    check(
      "feishu_cargo_migration_runs_source_spreadsheet_hash_format",
      sql`${table.sourceSpreadsheetHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "feishu_cargo_migration_runs_source_digest_format",
      sql`${table.sourceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "feishu_cargo_migration_runs_source_revision_non_negative",
      sql`${table.sourceRevision} >= 0`,
    ),
  ],
);
