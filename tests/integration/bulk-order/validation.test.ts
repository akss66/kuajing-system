import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  fulfillmentOrders,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  orderLines,
  products,
  skus,
  stores,
} from "@/db/schema";
import { validateBulkDraft } from "@/modules/bulk-order/validation-service";

type SeedRow = {
  errorCode?: string | null;
  errorMessage?: string | null;
  externalSubOrderNo?: string | null;
  quantity?: number | null;
  recipientPayloadEncrypted?: string | null;
  resolvedSkuId?: string | null;
  rowNumber: number;
  status?: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
};

const future = () => new Date(Date.now() + 60 * 60 * 1_000);

async function createDraftFixture(groupNames: readonly string[]) {
  const [customer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "校验客户" })
    .returning();
  const [otherCustomer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "其他客户" })
    .returning();
  const createdStores = await db
    .insert(stores)
    .values(
      [...groupNames, "outside"].map((name) => ({
        customerId: customer.id,
        name: `店铺-${name}-${crypto.randomUUID()}`,
      })),
    )
    .returning();
  const [draft] = await db
    .insert(bulkImportDrafts)
    .values({ customerId: customer.id, expiresAt: future() })
    .returning();
  const createdGroups = await db
    .insert(bulkImportStoreGroups)
    .values(
      groupNames.map((name, index) => ({
        customerId: customer.id,
        draftId: draft.id,
        storeId: createdStores[index].id,
      })),
    )
    .returning();

  return {
    customer,
    draft,
    groups: new Map(
      groupNames.map((name, index) => [
        name,
        { ...createdGroups[index], store: createdStores[index] },
      ]),
    ),
    otherCustomer,
    outsideStore: createdStores.at(-1)!,
  };
}

async function createSku(input: {
  code: string;
  stock: number;
}) {
  const [product] = await db
    .insert(products)
    .values({ name: `商品-${input.code}-${crypto.randomUUID()}` })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 100,
      name: `规格-${input.code}`,
      productId: product.id,
      skuCode: `${input.code}-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({
    skuId: sku.id,
    totalQuantity: input.stock,
  });
  return sku;
}

async function seedBatch(input: {
  batchId?: string;
  createdAt?: Date;
  customerId: string;
  fileHash?: string;
  groupId: string;
  rows: readonly SeedRow[];
  storeId: string;
}) {
  const counts = {
    DUPLICATE: 0,
    INVALID: 0,
    READY: 0,
    UNKNOWN_SKU: 0,
  };
  for (const row of input.rows) counts[row.status ?? "READY"] += 1;
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      createdAt: input.createdAt,
      customerId: input.customerId,
      duplicateRows: counts.DUPLICATE,
      expiresAt: future(),
      fileSha256: input.fileHash ?? crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      fileSizeBytes: 1,
      id: input.batchId,
      invalidRows: counts.INVALID,
      originalFileName: "validation.xlsx",
      readyRows: counts.READY,
      storeGroupId: input.groupId,
      storeId: input.storeId,
      totalRows: input.rows.length,
      unknownSkuRows: counts.UNKNOWN_SKU,
    })
    .returning();

  if (input.rows.length > 0) {
    await db.insert(orderImportRows).values(
      input.rows.map((row) => ({
        batchId: batch.id,
        errorCode: row.errorCode ?? null,
        errorMessage: row.errorMessage ?? null,
        externalOrderNo: row.externalSubOrderNo
          ? `PO-${row.externalSubOrderNo}`
          : null,
        externalSku: row.status === "INVALID" ? null : "VALIDATION-SKU",
        externalSubOrderNo: row.externalSubOrderNo ?? null,
        productAttributes: null,
        productName: null,
        quantity: row.quantity ?? null,
        recipientPayloadEncrypted: row.recipientPayloadEncrypted ?? null,
        resolvedSkuId: row.resolvedSkuId ?? null,
        rowNumber: row.rowNumber,
        status: row.status ?? "READY",
      })),
    );
  }
  return batch;
}

async function seedExistingOrder(input: {
  customerId: string;
  externalSubOrderNo: string;
  skuId: string;
  storeId: string;
}) {
  const [order] = await db
    .insert(fulfillmentOrders)
    .values({
      customerId: input.customerId,
      orderNumber: `VAL-${crypto.randomUUID()}`,
      storeId: input.storeId,
      totalAmountFen: 100,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: "VALIDATION-SKU",
    externalSubOrderNo: input.externalSubOrderNo,
    lineAmountFen: 100,
    orderId: order.id,
    quantity: 1,
    skuCodeSnapshot: "VALIDATION-SKU",
    skuId: input.skuId,
    skuNameSnapshot: "校验规格",
    storeId: input.storeId,
    unitPriceFen: 100,
  });
}

describe("bulk draft validation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        order_lines,
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

  test("deterministically deduplicates a store and blocks every affected cross-store, validation, and shortage group", async () => {
    const fixture = await createDraftFixture([
      "file-a",
      "file-b",
      "sub-a",
      "sub-b",
      "clean",
      "unknown",
      "invalid",
      "short-a",
      "short-b",
      "unaffected",
    ]);
    const mainSku = await createSku({ code: "MAIN", stock: 100 });
    const shortSku = await createSku({ code: "SHORT", stock: 7 });
    const unaffectedSku = await createSku({ code: "OTHER", stock: 2 });
    await db.insert(inventoryReservations).values({
      quantity: 2,
      referenceId: crypto.randomUUID(),
      referenceType: "ORDER",
      skuId: shortSku.id,
    });

    const fileA = fixture.groups.get("file-a")!;
    const fileB = fixture.groups.get("file-b")!;
    const subA = fixture.groups.get("sub-a")!;
    const subB = fixture.groups.get("sub-b")!;
    const clean = fixture.groups.get("clean")!;
    const unknown = fixture.groups.get("unknown")!;
    const invalid = fixture.groups.get("invalid")!;
    const shortA = fixture.groups.get("short-a")!;
    const shortB = fixture.groups.get("short-b")!;
    const unaffected = fixture.groups.get("unaffected")!;

    await seedBatch({
      customerId: fixture.customer.id,
      fileHash: "a".repeat(64),
      groupId: fileA.id,
      rows: [{ externalSubOrderNo: "SUB-FILE-A", quantity: 1, resolvedSkuId: mainSku.id, rowNumber: 2 }],
      storeId: fileA.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      fileHash: "a".repeat(64),
      groupId: fileB.id,
      rows: [{ externalSubOrderNo: "SUB-FILE-B", quantity: 1, resolvedSkuId: mainSku.id, rowNumber: 2 }],
      storeId: fileB.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: subA.id,
      rows: [{ externalSubOrderNo: "SUB-CROSS-STORE", quantity: 1, resolvedSkuId: mainSku.id, rowNumber: 2 }],
      storeId: subA.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: subB.id,
      rows: [{ externalSubOrderNo: "SUB-CROSS-STORE", quantity: 1, resolvedSkuId: mainSku.id, rowNumber: 2 }],
      storeId: subB.storeId,
    });

    const sameCreatedAt = new Date("2026-08-12T02:00:00.000Z");
    await seedBatch({
      batchId: "00000000-0000-4000-8000-000000000002",
      createdAt: sameCreatedAt,
      customerId: fixture.customer.id,
      groupId: clean.id,
      rows: [{ externalSubOrderNo: "SUB-CLEAN-2", quantity: 60, resolvedSkuId: mainSku.id, rowNumber: 2 }],
      storeId: clean.storeId,
    });
    await seedBatch({
      batchId: "00000000-0000-4000-8000-000000000001",
      createdAt: sameCreatedAt,
      customerId: fixture.customer.id,
      groupId: clean.id,
      rows: [
        { externalSubOrderNo: "SUB-CLEAN-1", quantity: 1, resolvedSkuId: mainSku.id, rowNumber: 2 },
        { externalSubOrderNo: "SUB-CLEAN-1", quantity: 50, resolvedSkuId: mainSku.id, rowNumber: 3 },
        ...Array.from({ length: 8 }, (_, index) => ({
          externalSubOrderNo: `SUB-CLEAN-${index + 2}`,
          quantity: 1,
          resolvedSkuId: mainSku.id,
          rowNumber: index + 4,
        })),
      ],
      storeId: clean.storeId,
    });
    await seedExistingOrder({
      customerId: fixture.customer.id,
      externalSubOrderNo: "SUB-CLEAN-9",
      skuId: mainSku.id,
      storeId: clean.storeId,
    });
    await seedExistingOrder({
      customerId: fixture.customer.id,
      externalSubOrderNo: "SUB-CLEAN-8",
      skuId: mainSku.id,
      storeId: fixture.outsideStore.id,
    });

    await seedBatch({
      customerId: fixture.customer.id,
      groupId: unknown.id,
      rows: [{ externalSubOrderNo: "SUB-UNKNOWN", quantity: 1, rowNumber: 2, status: "UNKNOWN_SKU" }],
      storeId: unknown.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: invalid.id,
      rows: [{
        errorCode: "MISSING_ORDER_NUMBER",
        errorMessage: "100 Private Avenue",
        recipientPayloadEncrypted: "Sensitive Recipient +1 416 555 0100 sensitive@example.test",
        rowNumber: 2,
        status: "INVALID",
      }],
      storeId: invalid.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: shortA.id,
      rows: [{ externalSubOrderNo: "SUB-SHORT-A", quantity: 3, resolvedSkuId: shortSku.id, rowNumber: 2 }],
      storeId: shortA.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: shortB.id,
      rows: [{ externalSubOrderNo: "SUB-SHORT-B", quantity: 3, resolvedSkuId: shortSku.id, rowNumber: 2 }],
      storeId: shortB.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: unaffected.id,
      rows: [{ externalSubOrderNo: "SUB-OTHER", quantity: 2, resolvedSkuId: unaffectedSku.id, rowNumber: 2 }],
      storeId: unaffected.storeId,
    });

    const balancesBefore = await db
      .select()
      .from(inventoryBalances)
      .orderBy(asc(inventoryBalances.skuId));
    const reservationsBefore = await db
      .select()
      .from(inventoryReservations)
      .orderBy(asc(inventoryReservations.id));
    const result = await validateBulkDraft({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
    });

    expect(result.groups.get(fileA.id)?.status).toBe("BLOCKED_CROSS_STORE");
    expect(result.groups.get(fileB.id)?.status).toBe("BLOCKED_CROSS_STORE");
    expect(result.groups.get(subA.id)?.errorCodes).toContain("CROSS_STORE_SUB_ORDER");
    expect(result.groups.get(subB.id)?.status).toBe("BLOCKED_CROSS_STORE");
    expect(result.groups.get(clean.id)).toMatchObject({
      deduplicatedOrderCount: 8,
      existingOrderCount: 1,
      sameStoreDuplicateCount: 2,
      status: "SUBMITTABLE",
      totalQuantity: 8,
    });
    expect(result.groups.get(unknown.id)).toMatchObject({
      errorCodes: ["UNKNOWN_SKU"],
      status: "BLOCKED_UNKNOWN_SKU",
      unknownSkuCount: 1,
    });
    expect(result.groups.get(invalid.id)).toMatchObject({
      errorCodes: ["INVALID_ROW"],
      invalidRowCount: 1,
      status: "BLOCKED_INVALID",
    });
    expect(result.groups.get(shortA.id)?.status).toBe("BLOCKED_INVENTORY");
    expect(result.groups.get(shortB.id)?.errorCodes).toContain("INSUFFICIENT_STOCK");
    expect(result.shortageBySku.get(shortSku.id)).toEqual({
      availableQuantity: 5,
      requiredQuantity: 6,
    });
    expect(result.groups.get(unaffected.id)).toMatchObject({
      deduplicatedOrderCount: 1,
      status: "SUBMITTABLE",
      totalQuantity: 2,
    });
    await expect(
      db.select().from(inventoryBalances).orderBy(asc(inventoryBalances.skuId)),
    ).resolves.toEqual(balancesBefore);
    await expect(
      db.select().from(inventoryReservations).orderBy(asc(inventoryReservations.id)),
    ).resolves.toEqual(reservationsBefore);

    const serializedResult = JSON.stringify({
      groups: [...result.groups.values()],
      shortageBySku: [...result.shortageBySku],
    });
    expect(serializedResult).not.toContain("Sensitive Recipient");
    expect(serializedResult).not.toContain("+1 416 555 0100");
    expect(serializedResult).not.toContain("sensitive@example.test");
    expect(serializedResult).not.toContain("100 Private Avenue");
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain(
      "Sensitive Recipient",
    );
  });

  test("validates 100 files with a fixed number of batched reads instead of per-file or per-row queries", async () => {
    const fixture = await createDraftFixture(["scale"]);
    const group = fixture.groups.get("scale")!;
    const sku = await createSku({ code: "SCALE", stock: 100 });
    const batches = await db
      .insert(orderImportBatches)
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          customerId: fixture.customer.id,
          expiresAt: future(),
          fileSha256: index.toString(16).padStart(64, "0"),
          fileSizeBytes: 1,
          originalFileName: `scale-${index}.xlsx`,
          readyRows: 1,
          storeGroupId: group.id,
          storeId: group.storeId,
          totalRows: 1,
        })),
      )
      .returning({ id: orderImportBatches.id });
    await db.insert(orderImportRows).values(
      batches.map((batch, index) => ({
        batchId: batch.id,
        externalOrderNo: `PO-SCALE-${index}`,
        externalSku: "SCALE",
        externalSubOrderNo: `SUB-SCALE-${index}`,
        quantity: 1,
        resolvedSkuId: sku.id,
        rowNumber: 2,
        status: "READY" as const,
      })),
    );

    const selectSpy = vi.spyOn(db, "select");
    const executeSpy = vi.spyOn(db, "execute");
    const result = await validateBulkDraft({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
    });

    expect(result.groups.get(group.id)).toMatchObject({
      deduplicatedOrderCount: 100,
      status: "SUBMITTABLE",
      totalQuantity: 100,
    });
    expect(selectSpy.mock.calls.length + executeSpy.mock.calls.length).toBeLessThanOrEqual(6);
  });

  test("excludes submitted groups and their active reservations from fresh preview demand", async () => {
    const fixture = await createDraftFixture(["submitted", "preview"]);
    const submitted = fixture.groups.get("submitted")!;
    const preview = fixture.groups.get("preview")!;
    const sku = await createSku({ code: "PARTIAL", stock: 6 });
    await db
      .update(bulkImportDrafts)
      .set({ status: "PARTIALLY_SUBMITTED" })
      .where(eq(bulkImportDrafts.id, fixture.draft.id));
    await db
      .update(bulkImportStoreGroups)
      .set({ status: "SUBMITTED", submittedAt: new Date() })
      .where(eq(bulkImportStoreGroups.id, submitted.id));
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: submitted.id,
      rows: [{
        externalSubOrderNo: "SUB-ALREADY-SUBMITTED",
        quantity: 3,
        resolvedSkuId: sku.id,
        rowNumber: 2,
      }],
      storeId: submitted.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: preview.id,
      rows: [{
        externalSubOrderNo: "SUB-FRESH-PREVIEW",
        quantity: 3,
        resolvedSkuId: sku.id,
        rowNumber: 2,
      }],
      storeId: preview.storeId,
    });
    await db.insert(inventoryReservations).values({
      quantity: 3,
      referenceId: submitted.id,
      referenceType: "BULK_STORE_GROUP",
      skuId: sku.id,
    });

    const result = await validateBulkDraft({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
    });

    expect(result.groups.get(submitted.id)).toMatchObject({
      errorCodes: ["GROUP_ALREADY_SUBMITTED"],
      status: "ALREADY_SUBMITTED",
      totalQuantity: 0,
    });
    expect(result.groups.get(preview.id)).toMatchObject({
      deduplicatedOrderCount: 1,
      status: "SUBMITTABLE",
      totalQuantity: 3,
    });
    expect(result.shortageBySku).toEqual(new Map());
  });

  test("keeps submitted batches in cross-store conflict diagnostics for preview groups", async () => {
    const fixture = await createDraftFixture(["submitted-conflict", "preview-conflict"]);
    const submitted = fixture.groups.get("submitted-conflict")!;
    const preview = fixture.groups.get("preview-conflict")!;
    const sku = await createSku({ code: "CROSS-SUBMITTED", stock: 10 });
    const sharedFileHash = "f".repeat(64);
    await db
      .update(bulkImportDrafts)
      .set({ status: "PARTIALLY_SUBMITTED" })
      .where(eq(bulkImportDrafts.id, fixture.draft.id));
    await db
      .update(bulkImportStoreGroups)
      .set({ status: "SUBMITTED", submittedAt: new Date() })
      .where(eq(bulkImportStoreGroups.id, submitted.id));
    await seedBatch({
      customerId: fixture.customer.id,
      fileHash: sharedFileHash,
      groupId: submitted.id,
      rows: [{
        externalSubOrderNo: "SUB-SHARED-WITH-SUBMITTED",
        quantity: 1,
        resolvedSkuId: sku.id,
        rowNumber: 2,
      }],
      storeId: submitted.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      fileHash: sharedFileHash,
      groupId: preview.id,
      rows: [{
        externalSubOrderNo: "SUB-SHARED-WITH-SUBMITTED",
        quantity: 1,
        resolvedSkuId: sku.id,
        rowNumber: 2,
      }],
      storeId: preview.storeId,
    });

    const result = await validateBulkDraft({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
    });

    expect(result.groups.get(submitted.id)).toMatchObject({
      errorCodes: ["GROUP_ALREADY_SUBMITTED"],
      status: "ALREADY_SUBMITTED",
    });
    expect(result.groups.get(preview.id)).toMatchObject({
      errorCodes: ["CROSS_STORE_FILE", "CROSS_STORE_SUB_ORDER"],
      status: "BLOCKED_CROSS_STORE",
    });
  });

  test("uses Task 3 ownership isolation and keeps expired drafts readable as blocked previews", async () => {
    const fixture = await createDraftFixture(["expired"]);
    const group = fixture.groups.get("expired")!;
    const sku = await createSku({ code: "EXPIRED", stock: 1 });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [{ externalSubOrderNo: "SUB-EXPIRED", quantity: 1, resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: group.storeId,
    });

    await expect(
      validateBulkDraft({
        customerId: fixture.otherCustomer.id,
        draftId: fixture.draft.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });

    await db
      .update(bulkImportDrafts)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(bulkImportDrafts.id, fixture.draft.id));
    const result = await validateBulkDraft({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
    });

    expect(result.draftStatus).toBe("EXPIRED");
    expect(result.groups.get(group.id)).toMatchObject({
      errorCodes: ["DRAFT_EXPIRED"],
      status: "EXPIRED",
    });
    await expect(
      db
        .select({ status: bulkImportDrafts.status })
        .from(bulkImportDrafts)
        .where(eq(bulkImportDrafts.id, fixture.draft.id)),
    ).resolves.toEqual([{ status: "EXPIRED" }]);
  });
});
