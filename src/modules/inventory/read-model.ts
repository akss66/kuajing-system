import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db } from "@/db/client";
import {
  authUsers,
  feishuCargoMigrationRuns,
  fulfillmentOrders,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryStocktakeBatches,
  orderShipments,
  products,
  replacementRequests,
  skus,
} from "@/db/schema";

export type InventoryMovementReasonCode =
  (typeof inventoryMovements.$inferSelect)["reasonCode"];
export type InventoryMovementSource =
  | "SYSTEM_ORDER_SHIPMENT"
  | "ADMIN_OFFLINE_FULFILLMENT"
  | "ADMIN_ADJUSTMENT"
  | "STOCKTAKE"
  | "FEISHU_MIGRATION"
  | "SYSTEM_REVERSAL";

export type InventoryMovementOperator = {
  actorId: string | null;
  actorType: "ADMIN" | "CUSTOMER" | "SYSTEM";
  label: string;
};

export type InventoryMovementRelation =
  | {
      href: `/admin/orders/${string}`;
      id: string;
      label: string;
      type: "ORDER_SHIPMENT" | "REPLACEMENT";
    }
  | {
      href: "/admin/system/integrations";
      id: string;
      label: string;
      type: "FEISHU_MIGRATION";
    }
  | {
      href: null;
      id: string;
      label: string;
      type: "STOCKTAKE_BATCH";
    }
  | {
      href: null;
      id: null;
      label: "关联记录不可用";
      type: "UNAVAILABLE";
    };

export type InventorySnapshotFilters = {
  skuCode?: string;
};

export type InventorySnapshotRow = {
  availableQuantity: number;
  lockedQuantity: number;
  productId: string;
  productName: string;
  skuCode: string;
  skuId: string;
  skuName: string;
  specification: string | null;
  totalQuantity: number;
};

export type InventoryMovementFilters = {
  actorId?: string;
  from?: Date;
  movementType?: (typeof inventoryMovements.$inferSelect)["movementType"];
  page?: number;
  pageSize?: number;
  skuCode?: string;
  source?: InventoryMovementSource;
  to?: Date;
};

export type InventoryMovementRow = {
  afterQuantity: number;
  beforeQuantity: number;
  createdAt: Date;
  delta: number;
  id: string;
  movementType: (typeof inventoryMovements.$inferSelect)["movementType"];
  operator: InventoryMovementOperator;
  reasonCode: InventoryMovementReasonCode;
  reasonLabel: string;
  relation: InventoryMovementRelation | null;
  remark: string | null;
  skuCode: string;
  skuId: string;
  source: InventoryMovementSource;
};

export type InventoryMovementPage = {
  page: number;
  pageSize: number;
  rows: InventoryMovementRow[];
  total: number;
  totalPages: number;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 1_000_000;
const MAX_PAGE_SIZE = 100;

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function sourcePredicates() {
  const systemOrderShipmentMatch = or(
    eq(inventoryMovements.reasonCode, "SYSTEM_SHIPMENT"),
    and(
      eq(inventoryMovements.movementType, "SHIPMENT"),
      eq(inventoryMovements.referenceType, "ORDER_SHIPMENT"),
    ),
  )!;
  const offlineFulfillmentMatch = eq(
    inventoryMovements.reasonCode,
    "OFFLINE_FULFILLMENT",
  );
  const stocktakeMatch = or(
    isNotNull(inventoryMovements.stocktakeBatchId),
    eq(inventoryMovements.reasonCode, "STOCKTAKE_CORRECTION"),
  )!;
  const feishuMigrationMatch = or(
    eq(inventoryMovements.reasonCode, "FEISHU_INITIAL_IMPORT"),
    eq(inventoryMovements.referenceType, "FEISHU_CARGO_MIGRATION"),
  )!;
  const systemReversalMatch = or(
    eq(inventoryMovements.reasonCode, "SHIPMENT_REVERSAL"),
    eq(inventoryMovements.movementType, "REVERSAL"),
  )!;
  const notMatched = (predicate: SQL) =>
    sql`not coalesce(${predicate}, false)`;
  const feishuMigration = and(
    notMatched(stocktakeMatch),
    feishuMigrationMatch,
  )!;
  const offlineFulfillment = and(
    notMatched(stocktakeMatch),
    notMatched(feishuMigrationMatch),
    offlineFulfillmentMatch,
  )!;
  const systemOrderShipment = and(
    notMatched(stocktakeMatch),
    notMatched(feishuMigrationMatch),
    notMatched(offlineFulfillmentMatch),
    systemOrderShipmentMatch,
  )!;
  const systemReversal = and(
    notMatched(stocktakeMatch),
    notMatched(feishuMigrationMatch),
    notMatched(offlineFulfillmentMatch),
    notMatched(systemOrderShipmentMatch),
    systemReversalMatch,
  )!;
  const recognized = or(
    stocktakeMatch,
    feishuMigrationMatch,
    offlineFulfillmentMatch,
    systemOrderShipmentMatch,
    systemReversalMatch,
  )!;

  return {
    ADMIN_ADJUSTMENT: sql`not coalesce(${recognized}, false)`,
    ADMIN_OFFLINE_FULFILLMENT: offlineFulfillment,
    FEISHU_MIGRATION: feishuMigration,
    STOCKTAKE: stocktakeMatch,
    SYSTEM_ORDER_SHIPMENT: systemOrderShipment,
    SYSTEM_REVERSAL: systemReversal,
  } satisfies Record<InventoryMovementSource, SQL>;
}

function reasonLabel(
  reasonCode: InventoryMovementReasonCode,
  fallbackReason: string,
  delta: number,
) {
  switch (reasonCode) {
    case "RESTOCK_RECEIPT":
      return "补货入库";
    case "OFFLINE_FULFILLMENT":
      return "线下发货/人工出库";
    case "CUSTOMER_RETURN":
      return "客户退货入库";
    case "DAMAGED_WRITE_OFF":
      return "破损报废";
    case "STOCKTAKE_CORRECTION":
      return "盘点调整";
    case "OTHER":
      return delta > 0 ? "其他入库" : "其他出库";
    case "SYSTEM_SHIPMENT":
      return "系统发货扣减";
    case "SHIPMENT_REVERSAL":
      return "发货撤销回补";
    case "FEISHU_INITIAL_IMPORT":
      return "飞书初始导入";
    default:
      return fallbackReason;
  }
}

function movementSource(row: {
  movementType: (typeof inventoryMovements.$inferSelect)["movementType"];
  reasonCode: InventoryMovementReasonCode;
  referenceType: string | null;
  stocktakeBatchId: string | null;
}): InventoryMovementSource {
  if (
    row.stocktakeBatchId ||
    row.reasonCode === "STOCKTAKE_CORRECTION"
  ) {
    return "STOCKTAKE";
  }
  if (
    row.reasonCode === "FEISHU_INITIAL_IMPORT" ||
    row.referenceType === "FEISHU_CARGO_MIGRATION"
  ) {
    return "FEISHU_MIGRATION";
  }
  if (row.reasonCode === "OFFLINE_FULFILLMENT") {
    return "ADMIN_OFFLINE_FULFILLMENT";
  }
  if (
    row.reasonCode === "SYSTEM_SHIPMENT" ||
    (row.movementType === "SHIPMENT" &&
      row.referenceType === "ORDER_SHIPMENT")
  ) {
    return "SYSTEM_ORDER_SHIPMENT";
  }
  if (
    row.reasonCode === "SHIPMENT_REVERSAL" ||
    row.movementType === "REVERSAL"
  ) {
    return "SYSTEM_REVERSAL";
  }
  return "ADMIN_ADJUSTMENT";
}

export async function listInventorySnapshot(
  filters: InventorySnapshotFilters = {},
): Promise<InventorySnapshotRow[]> {
  const activeReservations = db
    .select({
      lockedQuantity:
        sql<number>`sum(${inventoryReservations.quantity})::int`
          .mapWith(Number)
          .as("locked_quantity"),
      skuId: inventoryReservations.skuId,
    })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.status, "ACTIVE"))
    .groupBy(inventoryReservations.skuId)
    .as("active_inventory_reservations");
  const skuCode = filters.skuCode?.trim();
  const rows = await db
    .select({
      availableQuantity:
        sql<number>`greatest(0, ${inventoryBalances.totalQuantity} - coalesce(${activeReservations.lockedQuantity}, 0))::int`.mapWith(
          Number,
        ),
      lockedQuantity:
        sql<number>`coalesce(${activeReservations.lockedQuantity}, 0)::int`.mapWith(
          Number,
        ),
      productId: products.id,
      productName: products.name,
      skuCode: skus.skuCode,
      skuId: skus.id,
      skuName: skus.name,
      specification: skus.specification,
      totalQuantity: inventoryBalances.totalQuantity,
    })
    .from(inventoryBalances)
    .innerJoin(skus, eq(skus.id, inventoryBalances.skuId))
    .innerJoin(products, eq(products.id, skus.productId))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .where(skuCode ? eq(skus.skuCode, skuCode) : undefined)
    .orderBy(asc(skus.skuCode), asc(skus.id));

  return rows;
}

async function relationMap(rows: readonly {
  referenceId: string | null;
  referenceType: string | null;
  stocktakeBatchId: string | null;
}[]) {
  const shipmentIds = rows
    .filter((row) => row.referenceType === "ORDER_SHIPMENT")
    .flatMap((row) => (row.referenceId ? [row.referenceId] : []));
  const feishuRunIds = rows
    .filter((row) => row.referenceType === "FEISHU_CARGO_MIGRATION")
    .flatMap((row) => (row.referenceId ? [row.referenceId] : []));
  const stocktakeBatchIds = rows.flatMap((row) =>
    row.stocktakeBatchId ? [row.stocktakeBatchId] : [],
  );
  const [shipments, feishuRuns, stocktakeBatches] = await Promise.all([
    shipmentIds.length
      ? db
          .select({
            orderId: fulfillmentOrders.id,
            orderNumber: fulfillmentOrders.orderNumber,
            replacementId: replacementRequests.id,
            shipmentId: orderShipments.id,
          })
          .from(orderShipments)
          .innerJoin(
            fulfillmentOrders,
            eq(fulfillmentOrders.id, orderShipments.orderId),
          )
          .leftJoin(
            replacementRequests,
            eq(
              replacementRequests.replacementShipmentId,
              orderShipments.id,
            ),
          )
          .where(inArray(orderShipments.id, shipmentIds))
      : [],
    feishuRunIds.length
      ? db
          .select({ id: feishuCargoMigrationRuns.id })
          .from(feishuCargoMigrationRuns)
          .where(inArray(feishuCargoMigrationRuns.id, feishuRunIds))
      : [],
    stocktakeBatchIds.length
      ? db
          .select({ id: inventoryStocktakeBatches.id })
          .from(inventoryStocktakeBatches)
          .where(inArray(inventoryStocktakeBatches.id, stocktakeBatchIds))
      : [],
  ]);

  const relations = new Map<string, InventoryMovementRelation>();
  for (const shipment of shipments) {
    relations.set(
      `ORDER_SHIPMENT:${shipment.shipmentId}`,
      shipment.replacementId
        ? {
            href: `/admin/orders/${shipment.orderId}`,
            id: shipment.replacementId,
            label: `补发 · ${shipment.orderNumber}`,
            type: "REPLACEMENT",
          }
        : {
            href: `/admin/orders/${shipment.orderId}`,
            id: shipment.shipmentId,
            label: `订单 · ${shipment.orderNumber}`,
            type: "ORDER_SHIPMENT",
          },
    );
  }
  for (const run of feishuRuns) {
    relations.set(`FEISHU_CARGO_MIGRATION:${run.id}`, {
      href: "/admin/system/integrations",
      id: run.id,
      label: `飞书迁移 · ${run.id.slice(0, 8)}`,
      type: "FEISHU_MIGRATION",
    });
  }
  for (const batch of stocktakeBatches) {
    relations.set(`STOCKTAKE_BATCH:${batch.id}`, {
      href: null,
      id: batch.id,
      label: `盘点批次 · ${batch.id.slice(0, 8)}`,
      type: "STOCKTAKE_BATCH",
    });
  }
  return relations;
}

function resolvedRelation(
  row: {
    referenceId: string | null;
    referenceType: string | null;
    stocktakeBatchId: string | null;
  },
  relations: ReadonlyMap<string, InventoryMovementRelation>,
): InventoryMovementRelation | null {
  if (row.stocktakeBatchId) {
    return (
      relations.get(`STOCKTAKE_BATCH:${row.stocktakeBatchId}`) ?? {
        href: null,
        id: null,
        label: "关联记录不可用",
        type: "UNAVAILABLE",
      }
    );
  }
  if (!row.referenceType && !row.referenceId) return null;
  if (row.referenceType && row.referenceId) {
    const relation = relations.get(`${row.referenceType}:${row.referenceId}`);
    if (relation) return relation;
  }
  return {
    href: null,
    id: null,
    label: "关联记录不可用",
    type: "UNAVAILABLE",
  };
}

export async function listInventoryMovements(
  filters: InventoryMovementFilters = {},
): Promise<InventoryMovementPage> {
  const page = boundedPositiveInteger(filters.page, 1, MAX_PAGE);
  const pageSize = boundedPositiveInteger(
    filters.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const predicates: SQL[] = [];
  const skuCode = filters.skuCode?.trim();
  const actorId = filters.actorId?.trim();
  if (skuCode) predicates.push(eq(skus.skuCode, skuCode));
  if (filters.from) predicates.push(gte(inventoryMovements.createdAt, filters.from));
  if (filters.to) predicates.push(lte(inventoryMovements.createdAt, filters.to));
  if (filters.movementType) {
    predicates.push(eq(inventoryMovements.movementType, filters.movementType));
  }
  if (actorId) predicates.push(eq(inventoryMovements.actorId, actorId));
  if (filters.source) predicates.push(sourcePredicates()[filters.source]);
  const where = predicates.length ? and(...predicates) : undefined;

  const [totalRow, selectedRows] = await Promise.all([
    db
      .select({ total: count() })
      .from(inventoryMovements)
      .innerJoin(skus, eq(skus.id, inventoryMovements.skuId))
      .where(where),
    db
      .select({
        actorId: inventoryMovements.actorId,
        actorType: inventoryMovements.actorType,
        afterQuantity: inventoryMovements.afterQuantity,
        beforeQuantity: inventoryMovements.beforeQuantity,
        createdAt: inventoryMovements.createdAt,
        delta: inventoryMovements.delta,
        id: inventoryMovements.id,
        movementType: inventoryMovements.movementType,
        operatorName: authUsers.name,
        reason: inventoryMovements.reason,
        reasonCode: inventoryMovements.reasonCode,
        referenceId: inventoryMovements.referenceId,
        referenceType: inventoryMovements.referenceType,
        remark: inventoryMovements.remark,
        skuCode: skus.skuCode,
        skuId: skus.id,
        stocktakeBatchId: inventoryMovements.stocktakeBatchId,
      })
      .from(inventoryMovements)
      .innerJoin(skus, eq(skus.id, inventoryMovements.skuId))
      .leftJoin(authUsers, eq(authUsers.id, inventoryMovements.actorId))
      .where(where)
      .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const relations = await relationMap(selectedRows);
  const total = totalRow[0]?.total ?? 0;

  return {
    page,
    pageSize,
    rows: selectedRows.map((row) => ({
      afterQuantity: row.afterQuantity,
      beforeQuantity: row.beforeQuantity,
      createdAt: row.createdAt,
      delta: row.delta,
      id: row.id,
      movementType: row.movementType,
      operator: {
        actorId: row.actorId,
        actorType: row.actorType,
        label:
          row.actorType === "SYSTEM"
            ? "系统"
            : row.operatorName?.trim() ||
              row.actorId ||
              (row.actorType === "ADMIN" ? "未知管理员" : "未知操作人"),
      },
      reasonCode: row.reasonCode,
      reasonLabel: reasonLabel(row.reasonCode, row.reason, row.delta),
      relation: resolvedRelation(row, relations),
      remark: row.remark,
      skuCode: row.skuCode,
      skuId: row.skuId,
      source: movementSource(row),
    })),
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}
