import { redirect } from "next/navigation";

import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import {
  adjustInventoryAction,
  setInventoryToActualCountAction,
} from "@/modules/inventory/actions";
import { listInventorySnapshot } from "@/modules/inventory/read-model";
import { inventoryMovementsRedirectHref } from "@/modules/inventory/movement-navigation";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

type InventoryPageSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<InventoryPageSearchParams>;
}) {
  const params = await searchParams;
  if (firstValue(params.view) === "movements") {
    redirect(inventoryMovementsRedirectHref(params));
  }

  const [snapshotRows, coverageRows] = await Promise.all([
    listInventorySnapshot(),
    getStockCoverageReport(),
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
      adjustInventoryAction={adjustInventoryAction}
      rows={rows}
      setInventoryToActualCountAction={setInventoryToActualCountAction}
    />
  );
}
