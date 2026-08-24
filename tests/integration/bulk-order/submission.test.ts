import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  bulkImportDrafts,
  bulkImportStoreGroups,
  customerSkuPrices,
  customers,
  fulfillmentOrderImportBatches,
  fulfillmentOrders,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  orderLines,
  orderShipments,
  products,
  settlementBatchOrders,
  settlementBatches,
  skus,
  stores,
} from "@/db/schema";
import { submitBulkDraft } from "@/modules/bulk-order/submission-service";
import { submitTemuImportBatch } from "@/modules/orders/submission";

type SeedRow = {
  effectiveQuantity?: number | null;
  externalOrderNo?: string | null;
  externalSku?: string | null;
  externalSubOrderNo?: string | null;
  fulfillmentMode?: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
  productName?: string | null;
  quantity?: number | null;
  recipientPayloadEncrypted?: string | null;
  resolvedSkuId?: string | null;
  rowNumber: number;
  status?: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
};

const future = () => new Date(Date.now() + 60 * 60 * 1_000);
const past = () => new Date(Date.now() - 60 * 1_000);

async function createDraftFixture(groupNames: readonly string[]) {
  const [customer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "批量提交客户" })
    .returning();
  const createdStores = await db
    .insert(stores)
    .values(
      groupNames.map((name) => ({
        customerId: customer.id,
        name: `批量店铺-${name}-${crypto.randomUUID()}`,
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
  };
}

async function createSku(input: {
  cargoPriceMilliYuan?: number;
  code: string;
  defaultPriceFen?: number;
  defaultPriceMilliYuan?: number;
  saleStatus?: "SELLABLE" | "NOT_SELLABLE";
  stock: number;
}) {
  const [product] = await db
    .insert(products)
    .values({
      name: `商品-${input.code}-${crypto.randomUUID()}`,
    })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan:
        input.cargoPriceMilliYuan ??
        input.defaultPriceMilliYuan ??
        (input.defaultPriceFen ?? 100) * 10,
      defaultUnitPriceFen: input.defaultPriceFen ?? 100,
      defaultUnitPriceMilliYuan:
        input.defaultPriceMilliYuan ?? (input.defaultPriceFen ?? 100) * 10,
      name: `规格-${input.code}`,
      productId: product.id,
      saleStatus: input.saleStatus,
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
  customerId: string;
  expiresAt?: Date;
  fileHash?: string;
  groupId: string;
  rows: readonly SeedRow[];
  storeId: string;
}) {
  const counts = { DUPLICATE: 0, INVALID: 0, READY: 0, UNKNOWN_SKU: 0 };
  for (const row of input.rows) counts[row.status ?? "READY"] += 1;
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: input.customerId,
      duplicateRows: counts.DUPLICATE,
      expiresAt: input.expiresAt ?? future(),
      fileSha256:
        input.fileHash ??
        crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      fileSizeBytes: 1,
      invalidRows: counts.INVALID,
      originalFileName: `submission-${crypto.randomUUID()}.xlsx`,
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
        errorCode: row.status === "INVALID" ? "INVALID_TEST_ROW" : null,
        errorMessage: row.status === "INVALID" ? "100 Private Avenue" : null,
        externalOrderNo:
          row.externalOrderNo === undefined
            ? `PO-${input.groupId}-${row.rowNumber}`
            : row.externalOrderNo,
        externalSku:
          row.externalSku === undefined ? "BULK-SKU" : row.externalSku,
        externalSubOrderNo:
          row.externalSubOrderNo === undefined
            ? `SUB-${input.groupId}-${row.rowNumber}`
            : row.externalSubOrderNo,
        effectiveQuantity:
          row.effectiveQuantity === undefined
            ? row.quantity === undefined
              ? 1
              : row.quantity
            : row.effectiveQuantity,
        fulfillmentMode: row.fulfillmentMode ?? "SYSTEM_SKU",
        productName: row.productName ?? null,
        quantity: row.quantity === undefined ? 1 : row.quantity,
        recipientPayloadEncrypted:
          row.recipientPayloadEncrypted === undefined
            ? "Sensitive Recipient +1 416 555 0100 sensitive@example.test"
            : row.recipientPayloadEncrypted,
        resolutionMethod:
          row.fulfillmentMode === "CUSTOMER_SUPPLIED"
            ? ("CUSTOMER_SUPPLIED" as const)
            : ("LEGACY" as const),
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
      orderNumber: `EX-${crypto.randomUUID().slice(0, 20)}`,
      storeId: input.storeId,
      totalAmountFen: 100,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  await db.insert(orderLines).values({
    externalSku: "BULK-SKU",
    externalSubOrderNo: input.externalSubOrderNo,
    lineAmountFen: 100,
    orderId: order.id,
    quantity: 1,
    skuCodeSnapshot: "EXISTING-SKU",
    skuId: input.skuId,
    skuNameSnapshot: "既有规格",
    storeId: input.storeId,
    unitPriceFen: 100,
  });
}

async function tableCounts() {
  const [orders, links, shipments, lines, reservations, settlements, allocations] =
    await Promise.all([
      db.select().from(fulfillmentOrders),
      db.select().from(fulfillmentOrderImportBatches),
      db.select().from(orderShipments),
      db.select().from(orderLines),
      db.select().from(inventoryReservations),
      db.select().from(settlementBatches),
      db.select().from(settlementBatchOrders),
    ]);
  return {
    allocations: allocations.length,
    lines: lines.length,
    links: links.length,
    orders: orders.length,
    reservations: reservations.length,
    settlements: settlements.length,
    shipments: shipments.length,
  };
}

async function storedSubmissionRequests(idempotencyKey: string) {
  const [registry] = await db.execute<{ tableName: string | null }>(sql`
    select to_regclass('public.bulk_submission_requests')::text as "tableName"
  `);
  expect(registry?.tableName).toBe("bulk_submission_requests");
  return db.execute<{
    customerId: string;
    draftId: string;
    idempotencyKey: string;
    payloadDigest: string;
    resultJson: unknown;
    settlementBatchId: string | null;
  }>(sql`
    select
      customer_id as "customerId",
      draft_id as "draftId",
      idempotency_key as "idempotencyKey",
      payload_digest as "payloadDigest",
      result_json as "resultJson",
      settlement_batch_id as "settlementBatchId"
    from bulk_submission_requests
    where idempotency_key = ${idempotencyKey}
  `);
}

describe("atomic partial bulk submission", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      do $$
      begin
        if to_regclass('public.bulk_submission_requests') is not null then
          execute 'truncate table bulk_submission_requests';
        end if;
      end $$;
    `));
    await db.execute(sql.raw(`
      truncate table
        integration_outbox,
        audit_logs,
        settlement_batch_orders,
        settlement_batches,
        order_lines,
        order_shipments,
        fulfillment_order_import_batches,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        bulk_import_store_groups,
        bulk_import_drafts,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        customer_sku_prices,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("serializes single and bulk submissions sharing the same active order keys", async () => {
    const fixture = await createDraftFixture(["cross-path"]);
    const group = fixture.groups.get("cross-path")!;
    const sku = await createSku({ code: "CROSS-PATH", stock: 10 });
    const sharedRow = {
      externalOrderNo: "PO-CROSS-PATH",
      externalSubOrderNo: "SUB-CROSS-PATH",
      resolvedSkuId: sku.id,
      rowNumber: 2,
    };
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [sharedRow],
      storeId: group.storeId,
    });
    const singleBatch = await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [sharedRow],
      storeId: group.storeId,
    });
    await db
      .update(orderImportBatches)
      .set({ storeGroupId: null })
      .where(eq(orderImportBatches.id, singleBatch.id));

    const [singleSubmission, bulkSubmission] = await Promise.allSettled([
      submitTemuImportBatch({
        actorUserId: "cross-path-customer",
        batchId: singleBatch.id,
        customerId: fixture.customer.id,
      }),
      submitBulkDraft({
        actorUserId: "cross-path-customer",
        customerId: fixture.customer.id,
        draftId: fixture.draft.id,
        idempotencyKey: "cross-path-concurrency",
        requestedWalletFen: 0,
        selectedGroupIds: [group.id],
      }),
    ]);

    expect(bulkSubmission.status).toBe("fulfilled");
    if (singleSubmission.status === "fulfilled") {
      expect(bulkSubmission).toMatchObject({
        status: "fulfilled",
        value: {
          createdOrders: [],
          failedGroups: [{ groupId: group.id, status: "DUPLICATE_CHANGED" }],
        },
      });
    } else {
      expect(singleSubmission.reason).toMatchObject({
        code: "NO_READY_ROWS",
        message: "没有可提交的新订单",
        name: "OrderSubmissionError",
      });
      expect(bulkSubmission).toMatchObject({
        status: "fulfilled",
        value: { createdOrders: [{ groupId: group.id }], failedGroups: [] },
      });
    }
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(orderShipments)).toHaveLength(1);
    expect(await db.select().from(orderLines)).toHaveLength(1);
    const reservations = await db.select().from(inventoryReservations);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ quantity: 1, skuId: sku.id });
  });

  test("creates eight store orders, keeps two groups affected by one short SKU repairable, and is idempotent", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `store-${index}`);
    const fixture = await createDraftFixture(names);
    const shortSku = await createSku({ code: "SHORT", stock: 3 });
    const healthySku = await createSku({ code: "HEALTHY", stock: 20 });
    await db.insert(customerSkuPrices).values({
      customerId: fixture.customer.id,
      skuId: healthySku.id,
      unitPriceFen: 75,
    });

    for (const [index, name] of names.entries()) {
      const group = fixture.groups.get(name)!;
      await seedBatch({
        customerId: fixture.customer.id,
        groupId: group.id,
        rows: [
          {
            externalOrderNo: `PO-${index}`,
            externalSubOrderNo: `SUB-${index}`,
            quantity: index < 2 ? 2 : 1,
            resolvedSkuId: index < 2 ? shortSku.id : healthySku.id,
            rowNumber: 2,
          },
        ],
        storeId: group.storeId,
      });
    }
    const multiFileGroup = fixture.groups.get("store-2")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: multiFileGroup.id,
      rows: [
        {
          externalOrderNo: "PO-2-SECOND-FILE",
          externalSubOrderNo: "SUB-2-SECOND-FILE",
          resolvedSkuId: healthySku.id,
          rowNumber: 2,
        },
      ],
      storeId: multiFileGroup.storeId,
    });

    const input = {
      actorUserId: "customer-user-bulk-submit",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "bulk-submit-8-success-2-failed",
      requestedWalletFen: 300,
      selectedGroupIds: names.map((name) => fixture.groups.get(name)!.id),
    };
    const result = await submitBulkDraft(input);
    const countsAfterFirst = await tableCounts();
    const repeated = await submitBulkDraft(input);

    expect(repeated).toEqual(result);
    expect(await tableCounts()).toEqual(countsAfterFirst);
    expect(result.createdOrders).toHaveLength(8);
    expect(result.failedGroups).toHaveLength(2);
    expect(new Set(result.createdOrders.map((row) => row.storeId)).size).toBe(8);
    expect(result.failedGroups.map((row) => row.status)).toEqual([
      "STOCK_CHANGED",
      "STOCK_CHANGED",
    ]);
    expect(result.settlementBatchId).toEqual(expect.any(String));
    expect(countsAfterFirst).toEqual({
      allocations: 8,
      lines: 9,
      links: 9,
      orders: 8,
      reservations: 8,
      settlements: 1,
      shipments: 9,
    });

    const orders = await db
      .select()
      .from(fulfillmentOrders)
      .orderBy(asc(fulfillmentOrders.storeId));
    expect(orders).toHaveLength(8);
    expect(orders.filter((row) => row.storeId === multiFileGroup.storeId)).toHaveLength(1);
    expect(orders.reduce((total, row) => total + row.totalAmountFen, 0)).toBe(12600);
    const linePrices = await db.select({ unitPriceFen: orderLines.unitPriceFen }).from(orderLines);
    expect(new Set(linePrices.map((line) => line.unitPriceFen))).toEqual(new Set([100]));
    const reservations = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.skuId, healthySku.id));
    expect(reservations.reduce((total, row) => total + row.quantity, 0)).toBe(9);
    expect(await db.select().from(inventoryMovements)).toEqual([]);
    const [settlement] = await db
      .select()
      .from(settlementBatches)
      .where(eq(settlementBatches.id, result.settlementBatchId!));
    expect(settlement).toMatchObject({
      customerId: fixture.customer.id,
      offlineAmountFen: 12600,
      totalAmountFen: 12600,
      walletAmountFen: 0,
    });

    const groups = await db
      .select()
      .from(bulkImportStoreGroups)
      .orderBy(asc(bulkImportStoreGroups.id));
    const failedIds = new Set(result.failedGroups.map((row) => row.groupId));
    expect(groups.filter((group) => failedIds.has(group.id)).map((group) => group.status)).toEqual([
      "PREVIEW",
      "PREVIEW",
    ]);
    expect(groups.filter((group) => !failedIds.has(group.id)).every((group) => group.status === "SUBMITTED")).toBe(true);
    const [draft] = await db
      .select()
      .from(bulkImportDrafts)
      .where(eq(bulkImportDrafts.id, fixture.draft.id));
    expect(draft.status).toBe("PARTIALLY_SUBMITTED");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Sensitive Recipient");
    expect(serialized).not.toContain("+1 416 555 0100");
    expect(serialized).not.toContain("sensitive@example.test");
    expect(serialized).not.toContain("100 Private Avenue");
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain(
      "Sensitive Recipient",
    );
  });

  test("rounds a bulk order line only after multiplying an exact milli-yuan price", async () => {
    const fixture = await createDraftFixture(["exact-price"]);
    const sku = await createSku({
      code: "EXACT-MILLI",
      defaultPriceFen: 33,
      defaultPriceMilliYuan: 325,
      stock: 10,
    });
    const group = fixture.groups.get("exact-price")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [
        {
          quantity: 3,
          resolvedSkuId: sku.id,
          rowNumber: 2,
        },
      ],
      storeId: group.storeId,
    });

    const result = await submitBulkDraft({
      actorUserId: "exact-price-customer",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "bulk-exact-milli-price",
      requestedWalletFen: 0,
      selectedGroupIds: [group.id],
    });

    expect(result.createdOrders).toHaveLength(1);
    const [order] = await db.select().from(fulfillmentOrders);
    const [line] = await db.select().from(orderLines);
    expect(order.totalAmountFen).toBe(1398);
    expect(line).toMatchObject({
      lineAmountFen: 98,
      unitPriceFen: 33,
      unitPriceMilliYuan: 325,
    });
  });

  test("submits customer-supplied and mixed packages with shipping fees but reserves only system stock", async () => {
    const fixture = await createDraftFixture(["customer-only", "mixed"]);
    const systemSku = await createSku({ code: "MIXED", stock: 10 });
    const customerOnly = fixture.groups.get("customer-only")!;
    const mixed = fixture.groups.get("mixed")!;

    await seedBatch({
      customerId: fixture.customer.id,
      groupId: customerOnly.id,
      rows: [
        {
          effectiveQuantity: 3,
          externalOrderNo: "PO-CUSTOMER-ONLY",
          externalSku: "VENDOR-ABC",
          externalSubOrderNo: "SUB-CUSTOMER-ONLY",
          fulfillmentMode: "CUSTOMER_SUPPLIED",
          productName: "客户原始商品名",
          quantity: 3,
          resolvedSkuId: null,
          rowNumber: 2,
        },
      ],
      storeId: customerOnly.storeId,
    });
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: mixed.id,
      rows: [
        {
          effectiveQuantity: 2,
          externalOrderNo: "PO-MIXED",
          externalSku: "TZX-MIXED-2PCS",
          externalSubOrderNo: "SUB-MIXED-SYSTEM",
          quantity: 1,
          resolvedSkuId: systemSku.id,
          rowNumber: 2,
        },
        {
          effectiveQuantity: 4,
          externalOrderNo: "PO-MIXED",
          externalSku: "SELLER-GIFT",
          externalSubOrderNo: "SUB-MIXED-CUSTOMER",
          fulfillmentMode: "CUSTOMER_SUPPLIED",
          productName: "赠品",
          quantity: 4,
          resolvedSkuId: null,
          rowNumber: 3,
        },
      ],
      storeId: mixed.storeId,
    });

    const result = await submitBulkDraft({
      actorUserId: "customer-supplied-bulk-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "customer-supplied-and-mixed",
      requestedWalletFen: 0,
      selectedGroupIds: [customerOnly.id, mixed.id],
    });

    expect(result.failedGroups).toEqual([]);
    expect(result.createdOrders).toHaveLength(2);
    const orders = await db.select().from(fulfillmentOrders);
    expect(orders.map((order) => order.totalAmountFen).sort((a, b) => a - b)).toEqual([
      1_300,
      1_500,
    ]);
    const lines = await db.select().from(orderLines);
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.externalSku === "VENDOR-ABC")).toMatchObject({
      lineAmountFen: 0,
      lineKind: "CUSTOMER_SUPPLIED",
      quantity: 3,
      skuId: null,
      skuNameSnapshot: "客户原始商品名",
      unitPriceFen: 0,
      unitPriceMilliYuan: 0,
    });
    expect(lines.find((line) => line.externalSku === "SELLER-GIFT")).toMatchObject({
      lineAmountFen: 0,
      lineKind: "CUSTOMER_SUPPLIED",
      quantity: 4,
      skuId: null,
      skuNameSnapshot: "赠品",
    });
    expect(lines.find((line) => line.externalSku === "TZX-MIXED-2PCS")).toMatchObject({
      lineAmountFen: 200,
      lineKind: "SYSTEM_SKU",
      quantity: 2,
      skuId: systemSku.id,
    });
    expect(await db.select().from(inventoryReservations)).toEqual([
      expect.objectContaining({ quantity: 2, skuId: systemSku.id }),
    ]);
  });

  test("rejects reuse of a customer idempotency key with a different payload", async () => {
    const fixture = await createDraftFixture(["only"]);
    const sku = await createSku({ code: "IDEMPOTENCY", stock: 2 });
    const group = fixture.groups.get("only")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: group.storeId,
    });
    const input = {
      actorUserId: "idempotency-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "same-key-different-payload",
      requestedWalletFen: 0,
      selectedGroupIds: [group.id],
    };

    const first = await submitBulkDraft(input);
    await expect(
      submitBulkDraft({ ...input, requestedWalletFen: 1 }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(await submitBulkDraft(input)).toEqual(first);
    expect((await tableCounts()).orders).toBe(1);
    expect((await tableCounts()).settlements).toBe(1);
  });

  test("replays a successful request from the business idempotency table after audit cleanup", async () => {
    const fixture = await createDraftFixture(["audit-independent"]);
    const sku = await createSku({ code: "AUDIT-INDEPENDENT", stock: 1 });
    const group = fixture.groups.get("audit-independent")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: group.storeId,
    });
    const input = {
      actorUserId: "audit-independent-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "audit-independent-success",
      requestedWalletFen: 0,
      selectedGroupIds: [group.id],
    };

    const first = await submitBulkDraft(input);
    await db.delete(auditLogs);
    const repeated = await submitBulkDraft(input);

    expect(repeated).toEqual(first);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(settlementBatches)).toHaveLength(1);
    const requests = await storedSubmissionRequests(input.idempotencyKey);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: input.idempotencyKey,
      resultJson: first,
      settlementBatchId: first.settlementBatchId,
    });
    expect(requests[0].payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("persists and replays a fully failed request without settlement or audit dependency", async () => {
    const fixture = await createDraftFixture(["fully-failed"]);
    const sku = await createSku({ code: "FULLY-FAILED", stock: 0 });
    const group = fixture.groups.get("fully-failed")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: group.storeId,
    });
    const input = {
      actorUserId: "fully-failed-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "fully-failed-stable-replay",
      requestedWalletFen: 999,
      selectedGroupIds: [group.id],
    };

    const first = await submitBulkDraft(input);
    await db.delete(auditLogs);
    const repeated = await submitBulkDraft(input);

    expect(first).toEqual({
      createdOrders: [],
      failedGroups: [
        { groupId: group.id, status: "STOCK_CHANGED", storeId: group.storeId },
      ],
      groupResults: [
        { groupId: group.id, status: "STOCK_CHANGED", storeId: group.storeId },
      ],
      settlementBatchId: null,
    });
    expect(repeated).toEqual(first);
    expect(await db.select().from(fulfillmentOrders)).toEqual([]);
    expect(await db.select().from(settlementBatches)).toEqual([]);
    expect(await db.select().from(inventoryReservations)).toEqual([]);
    expect(await db.select().from(auditLogs)).toEqual([]);
    const requests = await storedSubmissionRequests(input.idempotencyKey);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: input.idempotencyKey,
      resultJson: first,
      settlementBatchId: null,
    });
    expect(JSON.stringify(requests[0].resultJson)).not.toContain("Sensitive Recipient");
  });

  test("revalidates duplicates, cross-store conflicts, formats, store state, SKU state, and expiry", async () => {
    const fixture = await createDraftFixture([
      "duplicate",
      "cross-a",
      "cross-b",
      "unknown",
      "invalid",
      "disabled",
      "not-sellable",
      "expired",
      "malformed-ready",
    ]);
    const sellableSku = await createSku({ code: "VALID", stock: 20 });
    const disabledSku = await createSku({
      code: "NOT-SELLABLE",
      saleStatus: "NOT_SELLABLE",
      stock: 20,
    });
    const duplicate = fixture.groups.get("duplicate")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: duplicate.id,
      rows: [
        {
          externalSubOrderNo: "SUB-NOW-EXISTS",
          resolvedSkuId: sellableSku.id,
          rowNumber: 2,
        },
      ],
      storeId: duplicate.storeId,
    });
    await seedExistingOrder({
      customerId: fixture.customer.id,
      externalSubOrderNo: "SUB-NOW-EXISTS",
      skuId: sellableSku.id,
      storeId: duplicate.storeId,
    });

    const sharedHash = "f".repeat(64);
    for (const name of ["cross-a", "cross-b"] as const) {
      const group = fixture.groups.get(name)!;
      await seedBatch({
        customerId: fixture.customer.id,
        fileHash: sharedHash,
        groupId: group.id,
        rows: [{ resolvedSkuId: sellableSku.id, rowNumber: 2 }],
        storeId: group.storeId,
      });
    }
    const unknown = fixture.groups.get("unknown")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: unknown.id,
      rows: [{ resolvedSkuId: null, rowNumber: 2, status: "UNKNOWN_SKU" }],
      storeId: unknown.storeId,
    });
    const invalid = fixture.groups.get("invalid")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: invalid.id,
      rows: [{ resolvedSkuId: null, rowNumber: 2, status: "INVALID" }],
      storeId: invalid.storeId,
    });
    const disabled = fixture.groups.get("disabled")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: disabled.id,
      rows: [{ resolvedSkuId: sellableSku.id, rowNumber: 2 }],
      storeId: disabled.storeId,
    });
    await db
      .update(stores)
      .set({ status: "DISABLED" })
      .where(eq(stores.id, disabled.storeId));
    const notSellable = fixture.groups.get("not-sellable")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: notSellable.id,
      rows: [{ resolvedSkuId: disabledSku.id, rowNumber: 2 }],
      storeId: notSellable.storeId,
    });
    const expired = fixture.groups.get("expired")!;
    await seedBatch({
      customerId: fixture.customer.id,
      expiresAt: past(),
      groupId: expired.id,
      rows: [{ resolvedSkuId: sellableSku.id, rowNumber: 2 }],
      storeId: expired.storeId,
    });
    const malformedReady = fixture.groups.get("malformed-ready")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: malformedReady.id,
      rows: [
        { resolvedSkuId: sellableSku.id, rowNumber: 2 },
        {
          externalSubOrderNo: null,
          resolvedSkuId: sellableSku.id,
          rowNumber: 3,
        },
      ],
      storeId: malformedReady.storeId,
    });

    const result = await submitBulkDraft({
      actorUserId: "revalidation-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      idempotencyKey: "revalidation-key",
      requestedWalletFen: 0,
      selectedGroupIds: [...fixture.groups.values()].map((group) => group.id),
    });
    const statusByGroup = new Map(
      result.failedGroups.map((group) => [group.groupId, group.status]),
    );

    expect(result.createdOrders).toEqual([]);
    expect(result.settlementBatchId).toBeNull();
    expect(statusByGroup.get(duplicate.id)).toBe("DUPLICATE_CHANGED");
    expect(statusByGroup.get(fixture.groups.get("cross-a")!.id)).toBe(
      "CROSS_STORE_CONFLICT",
    );
    expect(statusByGroup.get(fixture.groups.get("cross-b")!.id)).toBe(
      "CROSS_STORE_CONFLICT",
    );
    expect(statusByGroup.get(unknown.id)).toBe("INVALID");
    expect(statusByGroup.get(invalid.id)).toBe("INVALID");
    expect(statusByGroup.get(disabled.id)).toBe("INVALID");
    expect(statusByGroup.get(notSellable.id)).toBe("INVALID");
    expect(statusByGroup.get(expired.id)).toBe("EXPIRED");
    expect(statusByGroup.get(malformedReady.id)).toBe("INVALID");
    expect(await db.select().from(settlementBatches)).toEqual([]);
    expect(await db.select().from(inventoryReservations)).toEqual([]);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
  });

  test("deduplicates selected group ids but rejects groups outside the owned draft", async () => {
    const owner = await createDraftFixture(["owner"]);
    const outsider = await createDraftFixture(["outsider"]);
    const sku = await createSku({ code: "OWNERSHIP", stock: 2 });
    const ownerGroup = owner.groups.get("owner")!;
    const outsiderGroup = outsider.groups.get("outsider")!;
    await seedBatch({
      customerId: owner.customer.id,
      groupId: ownerGroup.id,
      rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: ownerGroup.storeId,
    });

    await expect(
      submitBulkDraft({
        actorUserId: "owner-user",
        customerId: owner.customer.id,
        draftId: owner.draft.id,
        idempotencyKey: "foreign-group",
        requestedWalletFen: 0,
        selectedGroupIds: [ownerGroup.id, outsiderGroup.id],
      }),
    ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
    expect(await db.select().from(fulfillmentOrders)).toEqual([]);

    const result = await submitBulkDraft({
      actorUserId: "owner-user",
      customerId: owner.customer.id,
      draftId: owner.draft.id,
      idempotencyKey: "deduplicated-groups",
      requestedWalletFen: 0,
      selectedGroupIds: [ownerGroup.id, ownerGroup.id],
    });
    expect(result.createdOrders).toHaveLength(1);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
  });

  test("scopes idempotency keys by customer and never exposes another customer's draft", async () => {
    const first = await createDraftFixture(["first"]);
    const second = await createDraftFixture(["second"]);
    const sku = await createSku({ code: "CUSTOMER-SCOPE", stock: 2 });
    for (const fixture of [first, second]) {
      const group = [...fixture.groups.values()][0];
      await seedBatch({
        customerId: fixture.customer.id,
        groupId: group.id,
        rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
        storeId: group.storeId,
      });
    }

    await expect(
      submitBulkDraft({
        actorUserId: "first-user",
        customerId: second.customer.id,
        draftId: first.draft.id,
        idempotencyKey: "cross-customer-draft",
        requestedWalletFen: 0,
        selectedGroupIds: [[...first.groups.values()][0].id],
      }),
    ).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });

    const results = await Promise.all(
      [first, second].map((fixture, index) =>
        submitBulkDraft({
          actorUserId: `customer-${index}`,
          customerId: fixture.customer.id,
          draftId: fixture.draft.id,
          idempotencyKey: "customer-scoped-shared-key",
          requestedWalletFen: 0,
          selectedGroupIds: [[...fixture.groups.values()][0].id],
        }),
      ),
    );
    expect(results.every((result) => result.createdOrders.length === 1)).toBe(true);
    expect(new Set(results.map((result) => result.settlementBatchId)).size).toBe(2);
    expect(await db.select().from(settlementBatches)).toHaveLength(2);
  });

  test("does not create a second order when a submitted group is retried under a new key", async () => {
    const fixture = await createDraftFixture(["completed"]);
    const sku = await createSku({ code: "COMPLETED", stock: 2 });
    const group = fixture.groups.get("completed")!;
    await seedBatch({
      customerId: fixture.customer.id,
      groupId: group.id,
      rows: [{ resolvedSkuId: sku.id, rowNumber: 2 }],
      storeId: group.storeId,
    });
    const base = {
      actorUserId: "completed-user",
      customerId: fixture.customer.id,
      draftId: fixture.draft.id,
      requestedWalletFen: 0,
      selectedGroupIds: [group.id],
    };
    const first = await submitBulkDraft({ ...base, idempotencyKey: "completed-first" });
    expect(first.createdOrders).toHaveLength(1);
    const repeatedWithNewKey = await submitBulkDraft({
      ...base,
      idempotencyKey: "completed-second",
    });

    expect(repeatedWithNewKey.createdOrders).toEqual([]);
    expect(repeatedWithNewKey.failedGroups).toEqual([
      { groupId: group.id, status: "INVALID", storeId: group.storeId },
    ]);
    expect(await db.select().from(fulfillmentOrders)).toHaveLength(1);
    expect(await db.select().from(settlementBatches)).toHaveLength(1);
  });
});
