import { sql } from "drizzle-orm";
import {
  check,
  index,
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

import { skus } from "./catalog";
import { customers } from "./customers";
import { orderImportBatches, orderImportRows } from "./orders";

export const aiSkuMatchRunStatus = pgEnum("ai_sku_match_run_status", [
  "PENDING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
]);

export const aiSkuMatchSuggestionDecision = pgEnum(
  "ai_sku_match_suggestion_decision",
  ["PENDING", "ACCEPTED", "REJECTED", "STALE"],
);

export type AiSkuMatchCandidateSnapshot = {
  skuId: string;
  rank: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
};

export const aiSkuMatchRuns = pgTable(
  "ai_sku_match_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => orderImportBatches.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    model: varchar("model", { length: 80 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
    status: aiSkuMatchRunStatus("status").default("PENDING").notNull(),
    rowCount: integer("row_count").notNull(),
    suggestionCount: integer("suggestion_count").default(0).notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms"),
    safeErrorCode: varchar("safe_error_code", { length: 80 }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "ai_sku_match_runs_row_count_bounded",
      sql`${table.rowCount} > 0 and ${table.rowCount} <= 20`,
    ),
    check(
      "ai_sku_match_runs_suggestion_count_bounded",
      sql`${table.suggestionCount} >= 0 and ${table.suggestionCount} <= ${table.rowCount} * 3`,
    ),
    check(
      "ai_sku_match_runs_token_counts_non_negative",
      sql`(${table.promptTokens} is null or ${table.promptTokens} >= 0) and (${table.completionTokens} is null or ${table.completionTokens} >= 0)`,
    ),
    check(
      "ai_sku_match_runs_latency_non_negative",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      "ai_sku_match_runs_completion_consistent",
      sql`(${table.status} = 'PENDING' and ${table.completedAt} is null) or (${table.status} <> 'PENDING' and ${table.completedAt} is not null)`,
    ),
    check(
      "ai_sku_match_runs_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    index("ai_sku_match_runs_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("ai_sku_match_runs_expires_index").on(table.expiresAt),
  ],
);

export const aiSkuMatchSuggestions = pgTable(
  "ai_sku_match_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiSkuMatchRuns.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => orderImportBatches.id, { onDelete: "cascade" }),
    rowId: uuid("row_id")
      .notNull()
      .references(() => orderImportRows.id, { onDelete: "cascade" }),
    rowRevision: integer("row_revision").notNull(),
    promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
    inputFingerprint: varchar("input_fingerprint", { length: 64 }).notNull(),
    candidates: jsonb("candidates")
      .$type<AiSkuMatchCandidateSnapshot[]>()
      .notNull(),
    decision: aiSkuMatchSuggestionDecision("decision")
      .default("PENDING")
      .notNull(),
    acceptedSkuId: uuid("accepted_sku_id").references(() => skus.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "ai_sku_match_suggestions_revision_non_negative",
      sql`${table.rowRevision} >= 0`,
    ),
    check(
      "ai_sku_match_suggestions_fingerprint_format",
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ai_sku_match_suggestions_candidates_bounded",
      sql`jsonb_typeof(${table.candidates}) = 'array' and jsonb_array_length(${table.candidates}) between 1 and 3`,
    ),
    check(
      "ai_sku_match_suggestions_decision_consistent",
      sql`(${table.decision} = 'PENDING' and ${table.acceptedSkuId} is null and ${table.decidedAt} is null) or (${table.decision} = 'ACCEPTED' and ${table.acceptedSkuId} is not null and ${table.decidedAt} is not null) or (${table.decision} in ('REJECTED', 'STALE') and ${table.acceptedSkuId} is null and ${table.decidedAt} is not null)`,
    ),
    check(
      "ai_sku_match_suggestions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    uniqueIndex("ai_sku_match_suggestions_pending_row_revision_unique")
      .on(table.rowId, table.rowRevision, table.promptVersion)
      .where(sql`${table.decision} = 'PENDING'`),
    index("ai_sku_match_suggestions_customer_batch_index").on(
      table.customerId,
      table.batchId,
      table.decision,
    ),
    index("ai_sku_match_suggestions_expires_index").on(table.expiresAt),
  ],
);
