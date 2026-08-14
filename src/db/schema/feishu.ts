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

const MAX_SAFE_INTEGER = "9007199254740991";

function jsonPathLiteral(path: string) {
  return sql.raw(`'${path.replace(/'/g, "''")}'::jsonpath`);
}

function invalidRequiredNonNegativeSafeInteger(path: string) {
  return [
    `!exists(${path})`,
    `${path}.type() != "number"`,
    `${path} < 0`,
    `${path}.floor() != ${path}`,
    `${path} > ${MAX_SAFE_INTEGER}`,
  ].join(" || ");
}

function invalidRequiredPositiveSafeInteger(path: string) {
  return [
    `!exists(${path})`,
    `${path}.type() != "number"`,
    `${path} < 1`,
    `${path}.floor() != ${path}`,
    `${path} > ${MAX_SAFE_INTEGER}`,
  ].join(" || ");
}

function invalidOptionalPositiveSafeInteger(path: string) {
  return `exists(${path}) && !(${path}.type() == "number" && ${path} >= 1 && ${path}.floor() == ${path} && ${path} <= ${MAX_SAFE_INTEGER})`;
}

function invalidRequiredNonNegativeSafeIntegerOrNull(path: string) {
  return [
    `!exists(${path})`,
    `|| !(`,
    `${path}.type() == "null"`,
    `|| (`,
    `${path}.type() == "number"`,
    `&& ${path} >= 0`,
    `&& ${path}.floor() == ${path}`,
    `&& ${path} <= ${MAX_SAFE_INTEGER}`,
    `)`,
    `)`,
  ].join(" ");
}

const summaryJsonInvalidPath = `$ ? (
  ${invalidRequiredNonNegativeSafeInteger("@.productCount")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.skuCount")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.imageCount")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.totalQuantity")}
)`;

const normalizedRowsJsonInvalidPath = `$[*] ? (
  @.type() != "object" ||
  ${invalidRequiredPositiveSafeInteger("@.sourceRowNumber")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.defaultUnitPriceFen")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.defaultUnitPriceMilliYuan")} ||
  ${invalidRequiredNonNegativeSafeInteger("@.totalQuantity")} ||
  ${invalidRequiredNonNegativeSafeIntegerOrNull("@.weightGrams")} ||
  !exists(@.saleStatus) ||
  !(@.saleStatus == "SELLABLE" || @.saleStatus == "NOT_SELLABLE") ||
  exists(@.**.fileToken) ||
  exists(@.**.imageFileToken)
)`;

const temporaryAssetsJsonInvalidPath = `$[*] ? (
  @.type() != "object" ||
  ${invalidRequiredNonNegativeSafeInteger("@.byteSize")} ||
  !exists(@.mimeType) ||
  !(
    @.mimeType == "image/jpeg" ||
    @.mimeType == "image/png" ||
    @.mimeType == "image/webp"
  ) ||
  !exists(@.contentSha256) ||
  @.contentSha256.type() != "string" ||
  !(@.contentSha256 like_regex "^[0-9a-f]{64}$") ||
  exists(@.fileToken)
)`;

const issuesJsonInvalidPath = `$[*] ? (
  @.type() != "object" ||
  !exists(@.severity) ||
  !(
    @.severity == "BLOCKING" ||
    @.severity == "RETRYABLE" ||
    @.severity == "WARNING"
  ) ||
  ${invalidOptionalPositiveSafeInteger("@.sourceRowNumber")}
)`;

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
    check(
      "feishu_cargo_migration_runs_summary_json_valid",
      sql`jsonb_typeof(${table.summaryJson}) = 'object' and not jsonb_path_exists(${table.summaryJson}, ${jsonPathLiteral(summaryJsonInvalidPath)})`,
    ),
    check(
      "feishu_cargo_migration_runs_normalized_rows_json_valid",
      sql`jsonb_typeof(${table.normalizedRowsJson}) = 'array' and not jsonb_path_exists(${table.normalizedRowsJson}, ${jsonPathLiteral(normalizedRowsJsonInvalidPath)})`,
    ),
    check(
      "feishu_cargo_migration_runs_temporary_assets_json_valid",
      sql`jsonb_typeof(${table.temporaryAssetsJson}) = 'array' and not jsonb_path_exists(${table.temporaryAssetsJson}, ${jsonPathLiteral(temporaryAssetsJsonInvalidPath)})`,
    ),
    check(
      "feishu_cargo_migration_runs_issues_json_valid",
      sql`jsonb_typeof(${table.issuesJson}) = 'array' and not jsonb_path_exists(${table.issuesJson}, ${jsonPathLiteral(issuesJsonInvalidPath)})`,
    ),
  ],
);
