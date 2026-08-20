import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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

import { adminUsers } from "./identity";
import { fulfillmentOrders, orderShipments } from "./orders";

export const shipmentFulfillmentStatus = pgEnum(
  "shipment_fulfillment_status",
  [
    "PENDING",
    "SUBMITTING",
    "SUBMITTED",
    "FULFILLING",
    "SHIPPED",
    "EXCEPTION",
    "CANCEL_PENDING",
    "CANCELLED",
  ],
);

export const replacementRequestStatus = pgEnum("replacement_request_status", [
  "PENDING_FULFILLMENT",
  "FULFILLING",
  "SHIPPED",
  "EXCEPTION",
  "CANCELLED",
]);

export const integrationTarget = pgEnum("integration_target", [
  "JIFENG",
  "FEISHU_SHEET",
  "FEISHU_BOT",
]);

export const integrationOutboxStatus = pgEnum("integration_outbox_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

export const integrationAttemptOutcome = pgEnum(
  "integration_attempt_outcome",
  ["SUCCESS", "RETRYABLE_FAILURE", "PERMANENT_FAILURE"],
);

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const shipmentFulfillments = pgTable(
  "shipment_fulfillments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => orderShipments.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 40 }).default("JIFENG").notNull(),
    erpNo: varchar("erp_no", { length: 100 }).notNull(),
    status: shipmentFulfillmentStatus("status").default("PENDING").notNull(),
    externalOrderNo: varchar("external_order_no", { length: 160 }),
    jifengStatus: integer("jifeng_status"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextRetryAt: timestamp("next_retry_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastAttemptAt: timestamp("last_attempt_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastStatusPollAt: timestamp("last_status_poll_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastStatusPollErrorCode: varchar("last_status_poll_error_code", {
      length: 80,
    }),
    lastStatusPollErrorMessage: text("last_status_poll_error_message"),
    statusPollClaimToken: uuid("status_poll_claim_token"),
    statusPollFailureCount: integer("status_poll_failure_count")
      .default(0)
      .notNull(),
    statusPollLockedAt: timestamp("status_poll_locked_at", {
      mode: "date",
      withTimezone: true,
    }),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    shippedAt: timestamp("shipped_at", { mode: "date", withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("shipment_fulfillments_shipment_unique").on(table.shipmentId),
    uniqueIndex("shipment_fulfillments_erp_no_unique").on(table.erpNo),
    check(
      "shipment_fulfillments_provider_jifeng",
      sql`${table.provider} = 'JIFENG'`,
    ),
    check(
      "shipment_fulfillments_jifeng_status_range",
      sql`${table.jifengStatus} is null or ${table.jifengStatus} between 1 and 11`,
    ),
    check(
      "shipment_fulfillments_attempt_count_non_negative",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "shipment_fulfillments_status_poll_failure_count_non_negative",
      sql`${table.statusPollFailureCount} >= 0`,
    ),
    index("shipment_fulfillments_status_retry_index").on(
      table.status,
      table.nextRetryAt,
    ),
  ],
);

export const replacementRequests = pgTable(
  "replacement_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: "restrict" }),
    originalShipmentId: uuid("original_shipment_id").notNull(),
    replacementShipmentId: uuid("replacement_shipment_id").notNull(),
    createdByAdminUserId: uuid("created_by_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: replacementRequestStatus("status")
      .default("PENDING_FULFILLMENT")
      .notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "replacement_requests_original_order_fk",
      columns: [table.originalShipmentId, table.orderId],
      foreignColumns: [orderShipments.id, orderShipments.orderId],
    }).onDelete("restrict"),
    foreignKey({
      name: "replacement_requests_replacement_order_fk",
      columns: [table.replacementShipmentId, table.orderId],
      foreignColumns: [orderShipments.id, orderShipments.orderId],
    }).onDelete("restrict"),
    uniqueIndex("replacement_requests_shipment_unique").on(
      table.replacementShipmentId,
    ),
    check(
      "replacement_requests_reason_required",
      sql`nullif(trim(${table.reason}), '') is not null`,
    ),
    check(
      "replacement_requests_distinct_shipments",
      sql`${table.originalShipmentId} <> ${table.replacementShipmentId}`,
    ),
    index("replacement_requests_order_index").on(table.orderId),
  ],
);

export const integrationOutbox = pgTable(
  "integration_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    target: integrationTarget("target").notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 160 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: integrationOutboxStatus("status").default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", { mode: "date", withTimezone: true }),
    claimToken: uuid("claim_token"),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("integration_outbox_idempotency_unique").on(
      table.idempotencyKey,
    ),
    check(
      "integration_outbox_attempt_count_non_negative",
      sql`${table.attemptCount} >= 0`,
    ),
    index("integration_outbox_pending_index").on(
      table.target,
      table.status,
      table.nextAttemptAt,
    ),
    index("integration_outbox_reconciliation_lease_index").on(
      table.target,
      table.status,
      table.lockedAt,
    ),
  ],
);

export const integrationAttempts = pgTable(
  "integration_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => integrationOutbox.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: integrationAttemptOutcome("outcome").notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    responseMetadata: jsonb("response_metadata").$type<
      Record<string, unknown>
    >(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex("integration_attempts_event_number_unique").on(
      table.outboxEventId,
      table.attemptNumber,
    ),
    check(
      "integration_attempts_number_positive",
      sql`${table.attemptNumber} > 0`,
    ),
    index("integration_attempts_event_index").on(table.outboxEventId),
  ],
);
