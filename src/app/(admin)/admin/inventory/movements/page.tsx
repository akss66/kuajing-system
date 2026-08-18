import { Boxes } from "lucide-react";
import Link from "next/link";

import {
  InventoryMovementsView,
  type InventoryMovementFilterValues,
} from "@/components/inventory/inventory-movements-view";
import { PageHeading } from "@/components/layout/page-heading";
import { Button } from "@/components/ui/button";
import {
  listInventoryMovements,
  type InventoryMovementFilters,
  type InventoryMovementSource,
} from "@/modules/inventory/read-model";
import { inventoryDateBoundary } from "@/modules/inventory/movement-date";

type MovementPageSearchParams = Record<string, string | string[] | undefined>;

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

export default async function InventoryMovementsPage({
  searchParams,
}: {
  searchParams: Promise<MovementPageSearchParams>;
}) {
  const params = await searchParams;
  const actorId = firstValue(params.operator)?.trim() || undefined;
  const from = firstValue(params.from);
  const movementTypeValue = firstValue(params.type);
  const skuCode = firstValue(params.sku)?.trim() || undefined;
  const sourceValue = firstValue(params.source);
  const to = firstValue(params.to);
  const movementType = movementTypes.includes(
    movementTypeValue as (typeof movementTypes)[number],
  )
    ? (movementTypeValue as InventoryMovementFilters["movementType"])
    : undefined;
  const source = movementSources.includes(sourceValue as InventoryMovementSource)
    ? (sourceValue as InventoryMovementSource)
    : undefined;
  const filters: InventoryMovementFilterValues = {
    actorId,
    from,
    movementType,
    skuCode,
    source,
    to,
  };
  const movementPage = await listInventoryMovements({
    actorId,
    from: inventoryDateBoundary(from, "start"),
    movementType,
    page: positivePage(firstValue(params.page)),
    skuCode,
    source,
    to: inventoryDateBoundary(to, "end"),
  });

  return (
    <div className="min-w-0 space-y-6" data-inventory-movements-module>
      <PageHeading
        action={
          <Button asChild className="min-h-11" variant="outline">
            <Link href="/admin/inventory">
              <Boxes aria-hidden="true" />
              返回实时库存
            </Link>
          </Button>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "库存管理" },
          { label: "库存流水" },
        ]}
        description="独立追溯每一笔库存变动，按 SKU、时间、类型、操作人和来源筛选，并查看前值、差额、后值与关联单据。"
        title="库存流水"
      />
      <InventoryMovementsView
        filters={filters}
        movementPage={{
          ...movementPage,
          rows: movementPage.rows.map((movement) => ({
            ...movement,
            createdAt: movement.createdAt.toISOString(),
          })),
        }}
      />
    </div>
  );
}
