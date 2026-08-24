import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  inventoryBalances,
  orderImportBatches,
  orderImportRows,
  products,
  skus,
  stores,
} from "@/db/schema";
import { getBulkWorkspaceDraft } from "@/modules/bulk-order/workspace-query";

type ReadyRow = {
  effectiveQuantity: number;
  externalOrderNo: string;
  externalSku: string;
  externalSubOrderNo: string;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
  resolvedSkuId: string | null;
  rowNumber: number;
};

const future = () => new Date(Date.now() + 60 * 60 * 1_000);

async function createWorkspaceFixture(
  rows: (skuId: string) => readonly ReadyRow[],
) {
  const [customer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "工作台金额客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `金额店铺-${crypto.randomUUID()}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: `金额商品-${crypto.randomUUID()}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: 5_000,
      defaultUnitPriceMilliYuan: 5_000,
      name: "系统货品",
      productId: product.id,
      skuCode: `TZX-WORKSPACE-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: 100,
  });
  const [draft] = await db
    .insert(bulkImportDrafts)
    .values({ customerId: customer.id, expiresAt: future() })
    .returning();
  const [group] = await db
    .insert(bulkImportStoreGroups)
    .values({
      customerId: customer.id,
      draftId: draft.id,
      storeId: store.id,
    })
    .returning();
  const readyRows = rows(sku.id);
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: customer.id,
      duplicateRows: 0,
      expiresAt: future(),
      fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      fileSizeBytes: 1,
      invalidRows: 0,
      originalFileName: "workspace-pricing.xlsx",
      readyRows: readyRows.length,
      storeGroupId: group.id,
      storeId: store.id,
      totalRows: readyRows.length,
      unknownSkuRows: 0,
    })
    .returning();
  await db.insert(orderImportRows).values(
    readyRows.map((row) => ({
      ...row,
      batchId: batch.id,
      productAttributes: null,
      productName: null,
      quantity: row.effectiveQuantity,
      resolutionMethod:
        row.fulfillmentMode === "CUSTOMER_SUPPLIED"
          ? "CUSTOMER_SUPPLIED" as const
          : "EXACT" as const,
      status: "READY" as const,
    })),
  );

  return { customerId: customer.id, draftId: draft.id };
}

describe("bulk workspace pricing", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        order_lines,
        order_shipments,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        bulk_import_store_groups,
        bulk_import_drafts,
        inventory_reservations,
        inventory_balances,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("prices customer-supplied-only rows as one ¥13 fee per unique package", async () => {
    const fixture = await createWorkspaceFixture(() => [
      {
        effectiveQuantity: 1,
        externalOrderNo: "PACKAGE-A",
        externalSku: "QS-A",
        externalSubOrderNo: "SUB-A-1",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        resolvedSkuId: null,
        rowNumber: 2,
      },
      {
        effectiveQuantity: 3,
        externalOrderNo: "PACKAGE-A",
        externalSku: "QS-B",
        externalSubOrderNo: "SUB-A-2",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        resolvedSkuId: null,
        rowNumber: 3,
      },
      {
        effectiveQuantity: 1,
        externalOrderNo: "PACKAGE-B",
        externalSku: "QS-C",
        externalSubOrderNo: "SUB-B-1",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        resolvedSkuId: null,
        rowNumber: 4,
      },
    ]);

    const workspace = await getBulkWorkspaceDraft(
      fixture.customerId,
      fixture.draftId,
    );

    expect(workspace.groups[0]?.totalAmountFen).toBe(2_600);
  });

  test("charges merchandise for system rows and shipping only once for a mixed package", async () => {
    const fixture = await createWorkspaceFixture((skuId) => [
      {
        effectiveQuantity: 2,
        externalOrderNo: "MIXED-PACKAGE",
        externalSku: "TZX-SYSTEM",
        externalSubOrderNo: "MIXED-SYSTEM",
        fulfillmentMode: "SYSTEM_SKU",
        resolvedSkuId: skuId,
        rowNumber: 2,
      },
      {
        effectiveQuantity: 5,
        externalOrderNo: "MIXED-PACKAGE",
        externalSku: "QS-CUSTOMER",
        externalSubOrderNo: "MIXED-CUSTOMER",
        fulfillmentMode: "CUSTOMER_SUPPLIED",
        resolvedSkuId: null,
        rowNumber: 3,
      },
    ]);

    const workspace = await getBulkWorkspaceDraft(
      fixture.customerId,
      fixture.draftId,
    );

    // 2 × ¥5 system merchandise + one package × ¥13 shipping.
    expect(workspace.groups[0]?.totalAmountFen).toBe(2_300);
  });
});
