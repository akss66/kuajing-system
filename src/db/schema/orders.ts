import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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

export const fulfillmentPaymentMode = pgEnum("fulfillment_payment_mode", [
  "WALLET",
  "DIRECT_OFFLINE",
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

export const paymentClaimStatus = pgEnum("payment_claim_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
};

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
    productName: text("product_name"),
    productAttributes: text("product_attributes"),
    quantity: integer("quantity"),
    resolvedSkuId: uuid("resolved_sku_id").references(() => skus.id, {
      onDelete: "restrict",
    }),
    recipientPayloadEncrypted: text("recipient_payload_encrypted"),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
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
    index("order_import_rows_batch_status_index").on(
      table.batchId,
      table.status,
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
    uniqueIndex("order_shipments_store_external_order_unique").on(
      table.storeId,
      table.externalOrderNo,
    ),
    uniqueIndex("order_shipments_id_order_unique").on(
      table.id,
      table.orderId,
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
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id, { onDelete: "restrict" }),
    externalSubOrderNo: varchar("external_sub_order_no", { length: 160 }),
    externalSku: varchar("external_sku", { length: 160 }),
    skuCodeSnapshot: varchar("sku_code_snapshot", { length: 80 }).notNull(),
    skuNameSnapshot: varchar("sku_name_snapshot", { length: 200 }).notNull(),
    quantity: integer("quantity").notNull(),
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
      .on(table.storeId, table.externalSubOrderNo)
      .where(sql`${table.externalSubOrderNo} is not null`),
    check("order_lines_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "order_lines_unit_price_non_negative",
      sql`${table.unitPriceFen} >= 0`,
    ),
    check(
      "order_lines_amount_matches_quantity",
      sql`${table.lineAmountFen} = ${table.quantity} * ${table.unitPriceFen}`,
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
    uniqueIndex("wallet_transactions_order_debit_unique")
      .on(table.orderId)
      .where(sql`${table.transactionType} = 'ORDER_DEBIT'`),
    uniqueIndex("wallet_transactions_order_refund_unique")
      .on(table.orderId)
      .where(sql`${table.transactionType} = 'ORDER_REFUND'`),
    index("wallet_transactions_customer_created_index").on(
      table.customerId,
      table.createdAt,
    ),
    index("wallet_transactions_created_index").on(table.createdAt),
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
