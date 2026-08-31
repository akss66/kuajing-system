import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { actorType } from "./audit";
import { skus } from "./catalog";
import { customers, stores } from "./customers";
import { adminUsers } from "./identity";

export const orderImportStatus = pgEnum("order_import_status", [
  "PREVIEW",
  "SUBMITTED",
  "EXPIRED",
]);

export const orderImportRowStatus = pgEnum("order_import_row_status", [
  "READY",
  "DUPLICATE",
  "UNKNOWN_SKU",
  "INVALID",
]);

export const orderLineKind = pgEnum("order_line_kind", [
  "SYSTEM_SKU",
  "CUSTOMER_SUPPLIED",
]);

export const importSkuResolutionMethod = pgEnum(
  "import_sku_resolution_method",
  [
    "EXACT",
    "STORE_ALIAS",
    "GLOBAL_ALIAS",
    "NORMALIZED_SUFFIX",
    "MANUAL_OVERRIDE",
    "AI_CONFIRMED",
    "CUSTOMER_SUPPLIED",
    "LEGACY",
  ],
);

export const fulfillmentOrderSource = pgEnum("fulfillment_order_source", [
  "TEMU_EXCEL",
  "MANUAL",
]);

export const fulfillmentOrderStatus = pgEnum("fulfillment_order_status", [
  "PENDING_PAYMENT",
  "PAID_PENDING_FULFILLMENT",
  "FULFILLING",
  "SHIPPED",
  "FULFILLMENT_EXCEPTION",
  "CANCELLED",
  "EXPIRED",
]);

export const fulfillmentOrderCancellationState = pgEnum(
  "fulfillment_order_cancellation_state",
  ["NONE", "PARTIAL", "ALL"],
);

export const fulfillmentPaymentMode = pgEnum("fulfillment_payment_mode", [
  "WALLET",
  "DIRECT_OFFLINE",
  "MIXED",
]);

export const shipmentKind = pgEnum("shipment_kind", [
  "NORMAL",
  "REPLACEMENT",
]);

export const walletTransactionType = pgEnum("wallet_transaction_type", [
  "ADMIN_CREDIT",
  "ADMIN_DEBIT",
  "ORDER_DEBIT",
  "ORDER_REFUND",
]);

export const shipmentCancellationAdjustmentStatus = pgEnum(
  "shipment_cancellation_adjustment_status",
  ["NOT_PAID", "PENDING_OFFLINE", "COMPLETED"],
);

export const paymentClaimStatus = pgEnum("payment_claim_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const bulkImportDraftStatus = pgEnum("bulk_import_draft_status", [
  "DRAFT",
  "PARTIALLY_SUBMITTED",
  "COMPLETED",
  "EXPIRED",
]);

export const walletHoldStatus = pgEnum("wallet_hold_status", [
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
]);

export const settlementBatchStatus = pgEnum("settlement_batch_status", [
  "PENDING_PAYMENT",
  "PAYMENT_REPORTED",
  "PAID",
  "REJECTED",
  "WITHDRAWN",
  "CANCELLED",
  "EXPIRED",
]);

export const settlementPaymentClaimStatus = pgEnum(
  "settlement_payment_claim_status",
  ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"],
);

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const bulkImportDrafts = pgTable(
  "bulk_import_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: bulkImportDraftStatus("status").default("DRAFT").notNull(),
    version: integer("version").default(0).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    ...timestamps,
  },
  (table) => [
    unique("bulk_import_drafts_id_customer_unique").on(
      table.id,
      table.customerId,
    ),
    check("bulk_import_drafts_version_non_negative", sql`${table.version} >= 0`),
    index("bulk_import_drafts_customer_status_index").on(
      table.customerId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const bulkImportStoreGroups = pgTable(
  "bulk_import_store_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    draftId: uuid("draft_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    status: orderImportStatus("status").default("PREVIEW").notNull(),
    errorSummary: text("error_summary"),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "bulk_import_store_groups_draft_customer_fk",
      columns: [table.draftId, table.customerId],
      foreignColumns: [bulkImportDrafts.id, bulkImportDrafts.customerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "bulk_import_store_groups_store_customer_fk",
      columns: [table.storeId, table.customerId],
      foreignColumns: [stores.id, stores.customerId],
    }).onDelete("restrict"),
    uniqueIndex("bulk_import_store_groups_draft_store_unique").on(
      table.draftId,
      table.storeId,
    ),
    unique("bulk_import_store_groups_id_store_customer_unique").on(
      table.id,
      table.storeId,
      table.customerId,
    ),
    index("bulk_import_store_groups_draft_status_index").on(
      table.draftId,
      table.status,
    ),
  ],
);

export const orderImportBatches = pgTable(
  "order_import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    storeGroupId: uuid("store_group_id"),
    status: orderImportStatus("status").default("PREVIEW").notNull(),
    originalFileName: varchar("original_file_name", { length: 255 }).notNull(),
    fileSha256: varchar("file_sha256", { length: 64 }).notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    totalRows: integer("total_rows").default(0).notNull(),
    readyRows: integer("ready_rows").default(0).notNull(),
    duplicateRows: integer("duplicate_rows").default(0).notNull(),
    unknownSkuRows: integer("unknown_sku_rows").default(0).notNull(),
    invalidRows: integer("invalid_rows").default(0).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "order_import_batches_store_customer_fk",
      columns: [table.storeId, table.customerId],
      foreignColumns: [stores.id, stores.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_import_batches_store_group_fk",
      columns: [table.storeGroupId, table.storeId, table.customerId],
      foreignColumns: [
        bulkImportStoreGroups.id,
        bulkImportStoreGroups.storeId,
        bulkImportStoreGroups.customerId,
      ],
    }).onDelete("restrict"),
    check(
      "order_import_batches_file_size_non_negative",
      sql`${table.fileSizeBytes} >= 0`,
    ),
    check(
      "order_import_batches_counts_non_negative",
      sql`${table.totalRows} >= 0 and ${table.readyRows} >= 0 and ${table.duplicateRows} >= 0 and ${table.unknownSkuRows} >= 0 and ${table.invalidRows} >= 0`,
    ),
    check(
      "order_import_batches_counts_match_total",
      sql`${table.totalRows} = ${table.readyRows} + ${table.duplicateRows} + ${table.unknownSkuRows} + ${table.invalidRows}`,
    ),
    check(
      "order_import_batches_sha256_format",
      sql`${table.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index("order_import_batches_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("order_import_batches_store_hash_index").on(
      table.storeId,
      table.fileSha256,
    ),
  ],
);

export const orderImportRows = pgTable(
  "order_import_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => orderImportBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    status: orderImportRowStatus("status").notNull(),
    externalOrderNo: varchar("external_order_no", { length: 160 }),
    externalSubOrderNo: varchar("external_sub_order_no", { length: 160 }),
    externalSku: varchar("external_sku", { length: 160 }),
    finalSkuCode: varchar("final_sku_code", { length: 160 }),
    productName: text("product_name"),
    productAttributes: text("product_attributes"),
    quantity: integer("quantity"),
    effectiveQuantity: integer("effective_quantity"),
    quantityMultiplier: integer("quantity_multiplier").default(1).notNull(),
    fulfillmentMode: orderLineKind("fulfillment_mode")
      .default("SYSTEM_SKU")
      .notNull(),
    resolutionMethod: importSkuResolutionMethod("resolution_method")
      .default("LEGACY")
      .notNull(),
    resolvedSkuId: uuid("resolved_sku_id").references(() => skus.id, {
      onDelete: "restrict",
    }),
    recipientPayloadEncrypted: text("recipient_payload_encrypted"),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    revision: integer("revision").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("order_import_rows_batch_row_unique").on(
      table.batchId,
      table.rowNumber,
    ),
    check(
      "order_import_rows_row_number_positive",
      sql`${table.rowNumber} > 0`,
    ),
    check(
      "order_import_rows_quantity_positive_when_present",
      sql`${table.quantity} is null or ${table.quantity} > 0`,
    ),
    check(
      "order_import_rows_effective_quantity_positive_when_present",
      sql`${table.effectiveQuantity} is null or ${table.effectiveQuantity} > 0`,
    ),
    check(
      "order_import_rows_quantity_multiplier_positive",
      sql`${table.quantityMultiplier} > 0`,
    ),
    check("order_import_rows_revision_non_negative", sql`${table.revision} >= 0`),
    check(
      "order_import_rows_mode_resolution_consistent",
      sql`(${table.fulfillmentMode} = 'SYSTEM_SKU' and ${table.resolutionMethod} <> 'CUSTOMER_SUPPLIED') or (${table.fulfillmentMode} = 'CUSTOMER_SUPPLIED' and ${table.resolutionMethod} = 'CUSTOMER_SUPPLIED' and ${table.resolvedSkuId} is null and nullif(trim(${table.finalSkuCode}), '') is not null)`,
    ),
    check(
      "order_import_rows_ready_fields_consistent",
      sql`${table.status} <> 'READY' or (${table.effectiveQuantity} is not null and ((${table.fulfillmentMode} = 'SYSTEM_SKU' and ${table.resolvedSkuId} is not null) or (${table.fulfillmentMode} = 'CUSTOMER_SUPPLIED' and ${table.resolvedSkuId} is null)))`,
    ),
    index("order_import_rows_batch_status_index").on(
      table.batchId,
      table.status,
    ),
  ],
);

export const orderImportRowFulfillmentItems = pgTable(
  "order_import_row_fulfillment_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rowId: uuid("row_id")
      .notNull()
      .references(() => orderImportRows.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    finalSkuCode: varchar("final_sku_code", { length: 160 }).notNull(),
    effectiveQuantity: integer("effective_quantity").notNull(),
    fulfillmentMode: orderLineKind("fulfillment_mode").notNull(),
    resolvedSkuId: uuid("resolved_sku_id").references(() => skus.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("order_import_row_fulfillment_items_row_position_unique").on(
      table.rowId,
      table.position,
    ),
    check(
      "order_import_row_fulfillment_items_position_range",
      sql`${table.position} between 2 and 20`,
    ),
    check(
      "order_import_row_fulfillment_items_sku_not_blank",
      sql`nullif(trim(${table.finalSkuCode}), '') is not null`,
    ),
    check(
      "order_import_row_fulfillment_items_quantity_positive",
      sql`${table.effectiveQuantity} > 0`,
    ),
    check(
      "order_import_row_fulfillment_items_mode_consistent",
      sql`(${table.fulfillmentMode} = 'SYSTEM_SKU' and ${table.resolvedSkuId} is not null) or (${table.fulfillmentMode} = 'CUSTOMER_SUPPLIED' and ${table.resolvedSkuId} is null)`,
    ),
    index("order_import_row_fulfillment_items_row_index").on(table.rowId),
    index("order_import_row_fulfillment_items_sku_index").on(
      table.resolvedSkuId,
    ),
  ],
);

export const fulfillmentOrders = pgTable(
  "fulfillment_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderNumber: varchar("order_number", { length: 40 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    importBatchId: uuid("import_batch_id").references(
      () => orderImportBatches.id,
      { onDelete: "restrict" },
    ),
    source: fulfillmentOrderSource("source").default("TEMU_EXCEL").notNull(),
    status: fulfillmentOrderStatus("status")
      .default("PENDING_PAYMENT")
      .notNull(),
    cancellationState: fulfillmentOrderCancellationState("cancellation_state")
      .default("NONE")
      .notNull(),
    paymentMode: fulfillmentPaymentMode("payment_mode"),
    totalAmountFen: integer("total_amount_fen").notNull(),
    totalPackageCount: integer("total_package_count").notNull(),
    totalQuantity: integer("total_quantity").notNull(),
    lockExpiresAt: timestamp("lock_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    paymentDeclaredAt: timestamp("payment_declared_at", {
      mode: "date",
      withTimezone: true,
    }),
    paidAt: timestamp("paid_at", { mode: "date", withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", {
      mode: "date",
      withTimezone: true,
    }),
    cancelReason: text("cancel_reason"),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "fulfillment_orders_store_customer_fk",
      columns: [table.storeId, table.customerId],
      foreignColumns: [stores.id, stores.customerId],
    }).onDelete("restrict"),
    uniqueIndex("fulfillment_orders_import_batch_unique")
      .on(table.importBatchId)
      .where(sql`${table.importBatchId} is not null`),
    uniqueIndex("fulfillment_orders_id_store_unique").on(
      table.id,
      table.storeId,
    ),
    uniqueIndex("fulfillment_orders_id_customer_unique").on(
      table.id,
      table.customerId,
    ),
    check(
      "fulfillment_orders_amount_non_negative",
      sql`${table.totalAmountFen} >= 0`,
    ),
    check(
      "fulfillment_orders_package_count_non_negative",
      sql`${table.totalPackageCount} >= 0`,
    ),
    check(
      "fulfillment_orders_quantity_positive",
      sql`${table.totalQuantity} > 0`,
    ),
    check(
      "fulfillment_orders_cancel_reason_required",
      sql`${table.status} <> 'CANCELLED' or nullif(trim(${table.cancelReason}), '') is not null`,
    ),
    check(
      "fulfillment_orders_cancellation_state_matches_status",
      sql`(${table.cancellationState} = 'ALL' and ${table.status} = 'CANCELLED') or (${table.cancellationState} <> 'ALL' and ${table.status} <> 'CANCELLED')`,
    ),
    check(
      "fulfillment_orders_paid_mode_required",
      sql`${table.status} not in ('PAID_PENDING_FULFILLMENT', 'FULFILLING', 'SHIPPED', 'FULFILLMENT_EXCEPTION') or ${table.paymentMode} is not null`,
    ),
    index("fulfillment_orders_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("fulfillment_orders_status_lock_index").on(
      table.status,
      table.lockExpiresAt,
    ),
    index("fulfillment_orders_status_submitted_index").on(
      table.status,
      table.submittedAt,
    ),
  ],
);

export const fulfillmentOrderImportBatches = pgTable(
  "fulfillment_order_import_batches",
  {
    orderId: uuid("order_id")
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: "restrict" }),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => orderImportBatches.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "fulfillment_order_import_batches_pk",
      columns: [table.orderId, table.importBatchId],
    }),
    uniqueIndex("fulfillment_order_import_batches_import_batch_unique").on(
      table.importBatchId,
    ),
  ],
);

export const settlementBatches = pgTable(
  "settlement_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchNumber: varchar("batch_number", { length: 64 }).notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: settlementBatchStatus("status")
      .default("PENDING_PAYMENT")
      .notNull(),
    statusReason: text("status_reason"),
    totalAmountFen: integer("total_amount_fen").notNull(),
    walletAmountFen: integer("wallet_amount_fen").notNull(),
    offlineAmountFen: integer("offline_amount_fen").notNull(),
    paymentDueAt: timestamp("payment_due_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    paymentReportedAt: timestamp("payment_reported_at", {
      mode: "date",
      withTimezone: true,
    }),
    paidAt: timestamp("paid_at", { mode: "date", withTimezone: true }),
    closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("settlement_batches_batch_number_unique").on(table.batchNumber),
    uniqueIndex("settlement_batches_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    unique("settlement_batches_id_customer_unique").on(
      table.id,
      table.customerId,
    ),
    check(
      "settlement_batches_total_positive",
      sql`${table.totalAmountFen} > 0`,
    ),
    check(
      "settlement_batches_allocations_non_negative",
      sql`${table.walletAmountFen} >= 0 and ${table.offlineAmountFen} >= 0`,
    ),
    check(
      "settlement_batches_allocation_equation",
      sql`${table.totalAmountFen} = ${table.walletAmountFen} + ${table.offlineAmountFen}`,
    ),
    check(
      "settlement_batches_terminal_reason_required",
      sql`${table.status} not in ('REJECTED', 'WITHDRAWN', 'CANCELLED', 'EXPIRED') or nullif(trim(${table.statusReason}), '') is not null`,
    ),
    index("settlement_batches_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("settlement_batches_status_due_index").on(
      table.status,
      table.paymentDueAt,
    ),
    index("settlement_batches_status_reported_index").on(
      table.status,
      table.paymentReportedAt,
    ),
  ],
);

export const bulkSubmissionRequests = pgTable(
  "bulk_submission_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    draftId: uuid("draft_id").notNull(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    settlementBatchId: uuid("settlement_batch_id"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "bulk_submission_requests_draft_customer_fk",
      columns: [table.draftId, table.customerId],
      foreignColumns: [bulkImportDrafts.id, bulkImportDrafts.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "bulk_submission_requests_settlement_customer_fk",
      columns: [table.settlementBatchId, table.customerId],
      foreignColumns: [settlementBatches.id, settlementBatches.customerId],
    }).onDelete("restrict"),
    uniqueIndex("bulk_submission_requests_customer_key_unique").on(
      table.customerId,
      table.idempotencyKey,
    ),
    check(
      "bulk_submission_requests_payload_digest_format",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    index("bulk_submission_requests_draft_created_index").on(
      table.draftId,
      table.createdAt,
    ),
  ],
);

export const settlementBatchOrders = pgTable(
  "settlement_batch_orders",
  {
    settlementBatchId: uuid("settlement_batch_id").notNull(),
    orderId: uuid("order_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    totalAmountFen: integer("total_amount_fen").notNull(),
    walletAmountFen: integer("wallet_amount_fen").notNull(),
    offlineAmountFen: integer("offline_amount_fen").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "settlement_batch_orders_pk",
      columns: [table.settlementBatchId, table.orderId],
    }),
    foreignKey({
      name: "settlement_batch_orders_batch_customer_fk",
      columns: [table.settlementBatchId, table.customerId],
      foreignColumns: [settlementBatches.id, settlementBatches.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "settlement_batch_orders_order_customer_fk",
      columns: [table.orderId, table.customerId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.customerId],
    }).onDelete("restrict"),
    uniqueIndex("settlement_batch_orders_order_unique").on(table.orderId),
    check(
      "settlement_batch_orders_total_positive",
      sql`${table.totalAmountFen} > 0`,
    ),
    check(
      "settlement_batch_orders_allocations_non_negative",
      sql`${table.walletAmountFen} >= 0 and ${table.offlineAmountFen} >= 0`,
    ),
    check(
      "settlement_batch_orders_allocation_equation",
      sql`${table.totalAmountFen} = ${table.walletAmountFen} + ${table.offlineAmountFen}`,
    ),
    index("settlement_batch_orders_batch_index").on(table.settlementBatchId),
  ],
);

export const walletHolds = pgTable(
  "wallet_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    settlementBatchId: uuid("settlement_batch_id").notNull(),
    amountFen: integer("amount_fen").notNull(),
    status: walletHoldStatus("status").default("ACTIVE").notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
    releasedAt: timestamp("released_at", {
      mode: "date",
      withTimezone: true,
    }),
    releaseReason: text("release_reason"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "wallet_holds_batch_customer_fk",
      columns: [table.settlementBatchId, table.customerId],
      foreignColumns: [settlementBatches.id, settlementBatches.customerId],
    }).onDelete("restrict"),
    check("wallet_holds_amount_positive", sql`${table.amountFen} > 0`),
    check(
      "wallet_holds_consumed_at_required",
      sql`${table.status} <> 'CONSUMED' or ${table.consumedAt} is not null`,
    ),
    check(
      "wallet_holds_release_details_required",
      sql`${table.status} <> 'RELEASED' or (${table.releasedAt} is not null and nullif(trim(${table.releaseReason}), '') is not null)`,
    ),
    uniqueIndex("wallet_holds_settlement_active_unique")
      .on(table.settlementBatchId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("wallet_holds_customer_status_index").on(
      table.customerId,
      table.status,
    ),
  ],
);

export const settlementPaymentClaims = pgTable(
  "settlement_payment_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    settlementBatchId: uuid("settlement_batch_id").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: settlementPaymentClaimStatus("status")
      .default("PENDING")
      .notNull(),
    amountFen: integer("amount_fen").notNull(),
    note: text("note"),
    rejectionReason: text("rejection_reason"),
    withdrawalReason: text("withdrawal_reason"),
    reviewedByAdminUserId: uuid("reviewed_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    reviewedAt: timestamp("reviewed_at", {
      mode: "date",
      withTimezone: true,
    }),
    withdrawnAt: timestamp("withdrawn_at", {
      mode: "date",
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "settlement_payment_claims_batch_customer_fk",
      columns: [table.settlementBatchId, table.customerId],
      foreignColumns: [settlementBatches.id, settlementBatches.customerId],
    }).onDelete("restrict"),
    check(
      "settlement_payment_claims_amount_positive",
      sql`${table.amountFen} > 0`,
    ),
    check(
      "settlement_payment_claims_review_details_required",
      sql`(${table.status} <> 'APPROVED' or (${table.reviewedAt} is not null and ${table.reviewedByAdminUserId} is not null)) and (${table.status} <> 'REJECTED' or ${table.reviewedAt} is not null)`,
    ),
    check(
      "settlement_payment_claims_rejection_reason_required",
      sql`${table.status} <> 'REJECTED' or nullif(trim(${table.rejectionReason}), '') is not null`,
    ),
    check(
      "settlement_payment_claims_withdrawal_details_required",
      sql`${table.status} <> 'WITHDRAWN' or (${table.withdrawnAt} is not null and nullif(trim(${table.withdrawalReason}), '') is not null)`,
    ),
    uniqueIndex("settlement_payment_claims_batch_pending_unique")
      .on(table.settlementBatchId)
      .where(sql`${table.status} = 'PENDING'`),
    index("settlement_payment_claims_status_created_index").on(
      table.status,
      table.createdAt,
    ),
    index("settlement_payment_claims_status_reviewed_index").on(
      table.status,
      table.reviewedAt,
    ),
  ],
);

export const orderShipments = pgTable(
  "order_shipments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    kind: shipmentKind("kind").default("NORMAL").notNull(),
    deduplicationActive: boolean("deduplication_active").default(true).notNull(),
    shippingFeeFen: integer("shipping_fee_fen").default(1_300).notNull(),
    externalOrderNo: varchar("external_order_no", { length: 160 }).notNull(),
    recipientPayloadEncrypted: text("recipient_payload_encrypted").notNull(),
    countryCode: varchar("country_code", { length: 2 }).default("CA").notNull(),
    carrierCode: varchar("carrier_code", { length: 40 })
      .default("CANADA_POST")
      .notNull(),
    trackingNumber: varchar("tracking_number", { length: 160 }),
    shippedAt: timestamp("shipped_at", { mode: "date", withTimezone: true }),
    logisticsFeeMinor: integer("logistics_fee_minor"),
    logisticsCurrency: varchar("logistics_currency", { length: 3 }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "order_shipments_order_store_fk",
      columns: [table.orderId, table.storeId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.storeId],
    }).onDelete("restrict"),
    uniqueIndex("order_shipments_store_external_order_unique")
      .on(table.storeId, table.externalOrderNo)
      .where(sql`${table.deduplicationActive} = true`),
    uniqueIndex("order_shipments_id_order_unique").on(
      table.id,
      table.orderId,
    ),
    check(
      "order_shipments_shipping_fee_non_negative",
      sql`${table.shippingFeeFen} >= 0`,
    ),
    check(
      "order_shipments_logistics_fee_non_negative",
      sql`${table.logisticsFeeMinor} is null or ${table.logisticsFeeMinor} >= 0`,
    ),
    check(
      "order_shipments_logistics_currency_format",
      sql`${table.logisticsCurrency} is null or ${table.logisticsCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "order_shipments_logistics_fee_currency_pair",
      sql`${table.logisticsFeeMinor} is null or ${table.logisticsCurrency} is not null`,
    ),
    index("order_shipments_order_index").on(table.orderId),
    index("order_shipments_kind_shipped_index").on(
      table.kind,
      table.shippedAt,
    ),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: "restrict" }),
    shipmentId: uuid("shipment_id").references(() => orderShipments.id, {
      onDelete: "restrict",
    }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    lineKind: orderLineKind("line_kind").default("SYSTEM_SKU").notNull(),
    skuId: uuid("sku_id").references(() => skus.id, { onDelete: "restrict" }),
    deduplicationActive: boolean("deduplication_active").default(true).notNull(),
    externalSubOrderNo: varchar("external_sub_order_no", { length: 160 }),
    externalSku: varchar("external_sku", { length: 160 }),
    linePosition: integer("line_position").default(1).notNull(),
    skuCodeSnapshot: varchar("sku_code_snapshot", { length: 160 }).notNull(),
    skuNameSnapshot: varchar("sku_name_snapshot", { length: 200 }).notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMilliYuan: integer("unit_price_milli_yuan").default(0).notNull(),
    unitPriceFen: integer("unit_price_fen").notNull(),
    lineAmountFen: integer("line_amount_fen").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "order_lines_order_store_fk",
      columns: [table.orderId, table.storeId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "order_lines_shipment_order_fk",
      columns: [table.shipmentId, table.orderId],
      foreignColumns: [orderShipments.id, orderShipments.orderId],
    }).onDelete("restrict"),
    uniqueIndex("order_lines_store_external_sub_order_unique")
      .on(table.storeId, table.externalSubOrderNo, table.linePosition)
      .where(
        sql`${table.externalSubOrderNo} is not null and ${table.deduplicationActive} = true`,
      ),
    check("order_lines_position_positive", sql`${table.linePosition} > 0`),
    check("order_lines_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "order_lines_unit_price_milli_yuan_non_negative",
      sql`${table.unitPriceMilliYuan} >= 0`,
    ),
    check(
      "order_lines_unit_price_non_negative",
      sql`${table.unitPriceFen} >= 0`,
    ),
    check(
      "order_lines_unit_price_fen_matches_milli_yuan",
      sql`${table.unitPriceFen} = ((${table.unitPriceMilliYuan}::bigint + 5) / 10)`,
    ),
    check(
      "order_lines_amount_matches_exact_price",
      sql`${table.lineAmountFen} = ((((${table.quantity})::bigint * (${table.unitPriceMilliYuan})::bigint) + 5) / 10)`,
    ),
    check(
      "order_lines_kind_fields_consistent",
      sql`(${table.lineKind} = 'SYSTEM_SKU' and ${table.skuId} is not null) or (${table.lineKind} = 'CUSTOMER_SUPPLIED' and ${table.skuId} is null and ${table.unitPriceMilliYuan} = 0 and ${table.unitPriceFen} = 0 and ${table.lineAmountFen} = 0)`,
    ),
    index("order_lines_order_index").on(table.orderId),
    index("order_lines_sku_index").on(table.skuId),
  ],
);

export const walletAccounts = pgTable(
  "wallet_accounts",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "restrict" }),
    balanceFen: integer("balance_fen").default(0).notNull(),
    version: integer("version").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "wallet_accounts_balance_non_negative",
      sql`${table.balanceFen} >= 0`,
    ),
    check("wallet_accounts_version_non_negative", sql`${table.version} >= 0`),
  ],
);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => fulfillmentOrders.id, {
      onDelete: "restrict",
    }),
    shipmentId: uuid("shipment_id"),
    transactionType: walletTransactionType("transaction_type").notNull(),
    beforeBalanceFen: integer("before_balance_fen").notNull(),
    deltaFen: integer("delta_fen").notNull(),
    afterBalanceFen: integer("after_balance_fen").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "wallet_transactions_balances_non_negative",
      sql`${table.beforeBalanceFen} >= 0 and ${table.afterBalanceFen} >= 0`,
    ),
    check(
      "wallet_transactions_delta_non_zero",
      sql`${table.deltaFen} <> 0`,
    ),
    check(
      "wallet_transactions_balance_equation",
      sql`${table.afterBalanceFen} = ${table.beforeBalanceFen} + ${table.deltaFen}`,
    ),
    check(
      "wallet_transactions_order_link_matches_type",
      sql`(${table.transactionType} in ('ORDER_DEBIT', 'ORDER_REFUND') and ${table.orderId} is not null) or (${table.transactionType} in ('ADMIN_CREDIT', 'ADMIN_DEBIT') and ${table.orderId} is null)`,
    ),
    check(
      "wallet_transactions_delta_matches_type",
      sql`(${table.transactionType} in ('ADMIN_CREDIT', 'ORDER_REFUND') and ${table.deltaFen} > 0) or (${table.transactionType} in ('ADMIN_DEBIT', 'ORDER_DEBIT') and ${table.deltaFen} < 0)`,
    ),
    foreignKey({
      name: "wallet_transactions_order_customer_fk",
      columns: [table.orderId, table.customerId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.customerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "wallet_transactions_shipment_order_fk",
      columns: [table.shipmentId, table.orderId],
      foreignColumns: [orderShipments.id, orderShipments.orderId],
    }).onDelete("restrict"),
    check(
      "wallet_transactions_shipment_refund_only",
      sql`${table.shipmentId} is null or ${table.transactionType} = 'ORDER_REFUND'`,
    ),
    uniqueIndex("wallet_transactions_order_debit_unique")
      .on(table.orderId)
      .where(sql`${table.transactionType} = 'ORDER_DEBIT'`),
    uniqueIndex("wallet_transactions_order_refund_unique")
      .on(table.orderId)
      .where(
        sql`${table.transactionType} = 'ORDER_REFUND' and ${table.shipmentId} is null`,
      ),
    uniqueIndex("wallet_transactions_shipment_refund_unique")
      .on(table.shipmentId)
      .where(
        sql`${table.transactionType} = 'ORDER_REFUND' and ${table.shipmentId} is not null`,
      ),
    index("wallet_transactions_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("wallet_transactions_created_index").on(table.createdAt),
  ],
);

export const shipmentCancellationAdjustments = pgTable(
  "shipment_cancellation_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shipmentId: uuid("shipment_id").notNull(),
    orderId: uuid("order_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    merchandiseAmountFen: integer("merchandise_amount_fen").notNull(),
    shippingFeeFen: integer("shipping_fee_fen").notNull(),
    totalAmountFen: integer("total_amount_fen").notNull(),
    walletAmountFen: integer("wallet_amount_fen").notNull(),
    offlineAmountFen: integer("offline_amount_fen").notNull(),
    status: shipmentCancellationAdjustmentStatus("status").notNull(),
    reason: text("reason").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    offlineCompletedAt: timestamp("offline_completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    offlineCompletedByAdminUserId: uuid("offline_completed_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    offlineCompletionNote: text("offline_completion_note"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("shipment_cancellation_adjustments_shipment_unique").on(table.shipmentId),
    foreignKey({
      name: "shipment_cancellation_adjustments_shipment_order_fk",
      columns: [table.shipmentId, table.orderId],
      foreignColumns: [orderShipments.id, orderShipments.orderId],
    }).onDelete("restrict"),
    foreignKey({
      name: "shipment_cancellation_adjustments_order_customer_fk",
      columns: [table.orderId, table.customerId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.customerId],
    }).onDelete("restrict"),
    check(
      "shipment_cancellation_adjustments_amounts_positive",
      sql`${table.merchandiseAmountFen} >= 0 and ${table.shippingFeeFen} >= 0 and ${table.totalAmountFen} > 0`,
    ),
    check(
      "shipment_cancellation_adjustments_total_equation",
      sql`${table.totalAmountFen} = ${table.merchandiseAmountFen} + ${table.shippingFeeFen}`,
    ),
    check(
      "shipment_cancellation_adjustments_payment_allocation",
      sql`${table.walletAmountFen} >= 0 and ${table.offlineAmountFen} >= 0 and ((${table.status} = 'NOT_PAID' and ${table.walletAmountFen} = 0 and ${table.offlineAmountFen} = 0) or (${table.status} <> 'NOT_PAID' and ${table.totalAmountFen} = ${table.walletAmountFen} + ${table.offlineAmountFen}))`,
    ),
    check(
      "shipment_cancellation_adjustments_offline_state",
      sql`(${table.status} = 'NOT_PAID' and ${table.offlineCompletedAt} is null and ${table.offlineCompletedByAdminUserId} is null) or (${table.offlineAmountFen} = 0 and ${table.status} = 'COMPLETED' and ${table.offlineCompletedAt} is null and ${table.offlineCompletedByAdminUserId} is null) or (${table.offlineAmountFen} > 0 and ((${table.status} = 'PENDING_OFFLINE' and ${table.offlineCompletedAt} is null and ${table.offlineCompletedByAdminUserId} is null) or (${table.status} = 'COMPLETED' and ${table.offlineCompletedAt} is not null and ${table.offlineCompletedByAdminUserId} is not null)))`,
    ),
    index("shipment_cancellation_adjustments_order_created_index").on(
      table.orderId,
      table.createdAt,
    ),
    index("shipment_cancellation_adjustments_status_created_index").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const paymentClaims = pgTable(
  "payment_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: paymentClaimStatus("status").default("PENDING").notNull(),
    amountFen: integer("amount_fen").notNull(),
    note: text("note"),
    rejectionReason: text("rejection_reason"),
    reviewedByAdminUserId: uuid("reviewed_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    reviewedAt: timestamp("reviewed_at", {
      mode: "date",
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "payment_claims_order_customer_fk",
      columns: [table.orderId, table.customerId],
      foreignColumns: [fulfillmentOrders.id, fulfillmentOrders.customerId],
    }).onDelete("restrict"),
    check("payment_claims_amount_positive", sql`${table.amountFen} > 0`),
    check(
      "payment_claims_rejection_reason_required",
      sql`${table.status} <> 'REJECTED' or nullif(trim(${table.rejectionReason}), '') is not null`,
    ),
    uniqueIndex("payment_claims_order_pending_unique")
      .on(table.orderId)
      .where(sql`${table.status} = 'PENDING'`),
    index("payment_claims_status_created_index").on(
      table.status,
      table.createdAt,
    ),
    index("payment_claims_status_reviewed_index").on(
      table.status,
      table.reviewedAt,
    ),
  ],
);
