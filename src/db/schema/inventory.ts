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

import { actorType } from "./audit";
import { skus } from "./catalog";

export const inventoryReservationStatus = pgEnum(
  "inventory_reservation_status",
  ["ACTIVE", "RELEASED", "CONSUMED"],
);

export const inventoryMovementType = pgEnum("inventory_movement_type", [
  "MANUAL_INCREASE",
  "MANUAL_DECREASE",
  "SHIPMENT",
  "REVERSAL",
]);

export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    skuId: uuid("sku_id")
      .primaryKey()
      .references(() => skus.id, { onDelete: "restrict" }),
    totalQuantity: integer("total_quantity").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "inventory_balances_total_non_negative",
      sql`${table.totalQuantity} >= 0`,
    ),
  ],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: inventoryReservationStatus("status").default("ACTIVE").notNull(),
    referenceType: varchar("reference_type", { length: 60 }).notNull(),
    referenceId: varchar("reference_id", { length: 160 }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "inventory_reservations_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
    uniqueIndex("inventory_reservations_reference_sku_unique").on(
      table.referenceType,
      table.referenceId,
      table.skuId,
    ),
    index("inventory_reservations_active_sku_index")
      .on(table.skuId)
      .where(sql`${table.status} = 'ACTIVE'`),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skuId: uuid("sku_id")
      .notNull()
      .references(() => skus.id, { onDelete: "restrict" }),
    movementType: inventoryMovementType("movement_type").notNull(),
    beforeQuantity: integer("before_quantity").notNull(),
    delta: integer("delta").notNull(),
    afterQuantity: integer("after_quantity").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason").notNull(),
    remark: text("remark"),
    referenceType: varchar("reference_type", { length: 60 }),
    referenceId: varchar("reference_id", { length: 160 }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "inventory_movements_before_non_negative",
      sql`${table.beforeQuantity} >= 0`,
    ),
    check(
      "inventory_movements_after_non_negative",
      sql`${table.afterQuantity} >= 0`,
    ),
    check("inventory_movements_delta_non_zero", sql`${table.delta} <> 0`),
    index("inventory_movements_sku_created_index").on(
      table.skuId,
      table.createdAt,
    ),
  ],
);
