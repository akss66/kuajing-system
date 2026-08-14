import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import {
  adjustInventoryAction,
  setInventoryToActualCountAction,
} from "@/modules/inventory/actions";
import {
  listInventoryMovements,
  listInventorySnapshot,
  type InventoryMovementFilters,
  type InventoryMovementSource,
} from "@/modules/inventory/read-model";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

type InventoryPageSearchParams = Record<string, string | string[] | undefined>;

const movementTypes = [
  "MANUAL_INCREASE",
  "MANUAL_DECREASE",
  "SHIPMENT",
  "REVERSAL",
] as const;
const movementSources = [
  "SYSTEM_ORDER_SHIPMENT",
  "ADMIN_OFFLINE_FULFILLMENT",
  "ADMIN_ADJUSTMENT",
  "STOCKTAKE",
  "FEISHU_MIGRATION",
  "SYSTEM_REVERSAL",
] as const satisfies readonly InventoryMovementSource[];

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positivePage(value: string | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function dateBoundary(value: string | undefined, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<InventoryPageSearchParams>;
}) {
  const params = await searchParams;
  const activeView = firstValue(params.view) === "movements" ? "movements" : "snapshot";
  const skuCode = firstValue(params.sku)?.trim() || undefined;
  const from = firstValue(params.from);
  const to = firstValue(params.to);
  const actorId = firstValue(params.operator)?.trim() || undefined;
  const movementTypeValue = firstValue(params.type);
  const sourceValue = firstValue(params.source);
  const movementType = movementTypes.includes(
    movementTypeValue as (typeof movementTypes)[number],
  )
    ? (movementTypeValue as InventoryMovementFilters["movementType"])
    : undefined;
  const source = movementSources.includes(sourceValue as InventoryMovementSource)
    ? (sourceValue as InventoryMovementSource)
    : undefined;

  const movementFilters = {
    actorId,
    from,
    movementType,
    skuCode,
    source,
    to,
  };
  const [snapshotRows, coverageRows, movementPage] = await Promise.all([
    listInventorySnapshot(),
    getStockCoverageReport(),
    activeView === "movements"
      ? listInventoryMovements({
          actorId,
          from: dateBoundary(from),
          movementType,
          page: positivePage(firstValue(params.page)),
          skuCode,
          source,
          to: dateBoundary(to, true),
        })
      : Promise.resolve({ page: 1, pageSize: 20, rows: [], total: 0, totalPages: 0 }),
  ]);

  const coverageBySku = new Map(coverageRows.map((row) => [row.skuId, row]));
  const rows = snapshotRows.map((row) => {
    const coverage = coverageBySku.get(row.skuId);
    return {
      alertLevel: coverage?.alertLevel ?? ("NO_BASELINE" as const),
      available: row.availableQuantity,
      coverageDays: coverage?.coverageDays ?? null,
      id: row.skuId,
      locked: row.lockedQuantity,
      name: row.specification ?? row.skuName ?? row.productName,
      shippedQuantity7d: coverage?.shippedQuantity7d ?? 0,
      skuCode: row.skuCode,
      total: row.totalQuantity,
    };
  });

  return (
    <InventoryWorkspace
      activeView={activeView}
      adjustInventoryAction={adjustInventoryAction}
      movementFilters={movementFilters}
      movementPage={{
        ...movementPage,
        rows: movementPage.rows.map((movement) => ({
          ...movement,
          createdAt: movement.createdAt.toISOString(),
        })),
      }}
      rows={rows}
      setInventoryToActualCountAction={setInventoryToActualCountAction}
    />
  );
}
