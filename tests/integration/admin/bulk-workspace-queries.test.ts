import crypto from "node:crypto";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: vi.fn(async () => ({ kind: "ADMIN" as const, userId: "test-admin" })),
}));

import { db } from "@/db/client";
import {
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  fulfillmentOrders,
  orderImportBatches,
  orderImportRows,
  settlementBatchOrders,
  settlementBatches,
  stores,
} from "@/db/schema";
import { listAdminBulkDrafts } from "@/modules/bulk-order/admin-queries";
import { listAdminSettlementBatches } from "@/modules/settlement/admin-queries";

const matchingDate = new Date("2026-08-10T16:00:00.000Z");
const newerDate = new Date("2026-08-12T16:00:00.000Z");
const sameDayOlderDate = new Date("2026-08-10T16:00:00.000Z");
const sameDayNewerDate = new Date("2026-08-10T20:00:00.000Z");

async function createDraft(
  customerId: string,
  updatedAt: Date,
) {
  const [draft] = await db
    .insert(bulkImportDrafts)
    .values({
      createdAt: updatedAt,
      customerId,
      expiresAt: new Date("2026-08-20T00:00:00.000Z"),
      updatedAt,
    })
    .returning();
  return draft;
}

async function createStoreGroup(input: {
  customerId: string;
  draftId: string;
  status?: "PREVIEW" | "SUBMITTED" | "EXPIRED";
  storeId: string;
}) {
  const [group] = await db
    .insert(bulkImportStoreGroups)
    .values({
      customerId: input.customerId,
      draftId: input.draftId,
      status: input.status ?? "PREVIEW",
      storeId: input.storeId,
    })
    .returning();
  return group;
}

async function seedUnknownSkuBatch(input: {
  customerId: string;
  groupId: string;
  storeId: string;
  updatedAt: Date;
}) {
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      createdAt: input.updatedAt,
      customerId: input.customerId,
      duplicateRows: 0,
      expiresAt: new Date("2026-08-20T00:00:00.000Z"),
      fileSha256: "a".repeat(64),
      fileSizeBytes: 1,
      invalidRows: 0,
      originalFileName: "unknown-sku.xlsx",
      readyRows: 0,
      storeGroupId: input.groupId,
      storeId: input.storeId,
      totalRows: 1,
      unknownSkuRows: 1,
      updatedAt: input.updatedAt,
    })
    .returning();
  await db.insert(orderImportRows).values({
    batchId: batch.id,
    createdAt: input.updatedAt,
    errorCode: "UNKNOWN_SKU",
    externalSku: "UNKNOWN-SKU",
    externalSubOrderNo: `SUB-${crypto.randomUUID()}`,
    quantity: 1,
    rowNumber: 2,
    status: "UNKNOWN_SKU",
  });
}

afterEach(async () => {
  await db.execute(sql.raw("truncate table customers restart identity cascade"));
});

describe("admin bulk workspace queries", () => {
  test("returns an older bulk draft when every filter excludes more than 50 newer drafts", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer, otherCustomer] = await db
      .insert(customers)
      .values([
        { code: `MATCH-${suffix}`, name: "Matching customer" },
        { code: `OTHER-${suffix}`, name: "Other customer" },
      ])
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "Matching store" })
      .returning();
    const [matchingDraft] = await db
      .insert(bulkImportDrafts)
      .values({
        createdAt: matchingDate,
        customerId: customer.id,
        expiresAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: matchingDate,
      })
      .returning();
    await db.insert(bulkImportStoreGroups).values({
      customerId: customer.id,
      draftId: matchingDraft.id,
      status: "SUBMITTED",
      storeId: store.id,
    });
    await db.insert(bulkImportDrafts).values(
      Array.from({ length: 51 }, (_, index) => ({
        createdAt: newerDate,
        customerId: otherCustomer.id,
        expiresAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: newerDate,
        version: index,
      })),
    );

    await expect(
      listAdminBulkDrafts({
        customerId: customer.id,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        status: "ALREADY_SUBMITTED",
        storeId: store.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        diagnosticStatus: "ALREADY_SUBMITTED",
        id: matchingDraft.id,
      }),
    ]);
  });

  test("returns an older settlement batch when every filter excludes more than 50 newer batches", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer, otherCustomer] = await db
      .insert(customers)
      .values([
        { code: `MATCH-${suffix}`, name: "Matching customer" },
        { code: `OTHER-${suffix}`, name: "Other customer" },
      ])
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "Matching store" })
      .returning();
    const [order] = await db
      .insert(fulfillmentOrders)
      .values({
        createdAt: matchingDate,
        customerId: customer.id,
        orderNumber: `MATCH-ORDER-${suffix}`,
        storeId: store.id,
        submittedAt: matchingDate,
        totalAmountFen: 100,
        totalPackageCount: 1,
        totalQuantity: 1,
        updatedAt: matchingDate,
      })
      .returning();
    const [matchingBatch] = await db
      .insert(settlementBatches)
      .values({
        batchNumber: `MATCH-BATCH-${suffix}`,
        createdAt: matchingDate,
        customerId: customer.id,
        idempotencyKey: `match-${suffix}`,
        offlineAmountFen: 100,
        paymentDueAt: new Date("2026-08-20T00:00:00.000Z"),
        paymentReportedAt: matchingDate,
        status: "PAYMENT_REPORTED",
        totalAmountFen: 100,
        updatedAt: matchingDate,
        walletAmountFen: 0,
      })
      .returning();
    await db.insert(settlementBatchOrders).values({
      customerId: customer.id,
      offlineAmountFen: 100,
      orderId: order.id,
      settlementBatchId: matchingBatch.id,
      totalAmountFen: 100,
      walletAmountFen: 0,
    });
    await db.insert(settlementBatches).values(
      Array.from({ length: 51 }, (_, index) => ({
        batchNumber: `NEWER-${index}-${suffix}`,
        createdAt: newerDate,
        customerId: otherCustomer.id,
        idempotencyKey: `newer-${index}-${suffix}`,
        offlineAmountFen: 100,
        paymentDueAt: new Date("2026-08-20T00:00:00.000Z"),
        status: "PENDING_PAYMENT" as const,
        totalAmountFen: 100,
        updatedAt: newerDate,
        walletAmountFen: 0,
      })),
    );

    await expect(
      listAdminSettlementBatches({
        customerId: customer.id,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        status: "PAYMENT_REPORTED",
        storeId: store.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: matchingBatch.id, status: "PAYMENT_REPORTED" }),
    ]);
  });

  test("returns an older BLOCKED_UNKNOWN_SKU draft when 51 newer same-customer drafts do not match the derived status filter", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values([{ code: `MATCH-${suffix}`, name: "Matching customer" }])
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "Matching store" })
      .returning();

    const matchingDraft = await createDraft(customer.id, sameDayOlderDate);
    const matchingGroup = await createStoreGroup({
      customerId: customer.id,
      draftId: matchingDraft.id,
      storeId: store.id,
    });
    await seedUnknownSkuBatch({
      customerId: customer.id,
      groupId: matchingGroup.id,
      storeId: store.id,
      updatedAt: sameDayOlderDate,
    });

    for (let index = 0; index < 51; index += 1) {
      const newerDraft = await createDraft(customer.id, sameDayNewerDate);
      await createStoreGroup({
        customerId: customer.id,
        draftId: newerDraft.id,
        status: "SUBMITTED",
        storeId: store.id,
      });
    }

    await expect(
      listAdminBulkDrafts({
        customerId: customer.id,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        status: "BLOCKED_UNKNOWN_SKU",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        diagnosticStatus: "BLOCKED_UNKNOWN_SKU",
        id: matchingDraft.id,
      }),
    ]);
  });

  test("returns an older EMPTY draft when 51 newer same-customer drafts do not match the derived status filter", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [customer] = await db
      .insert(customers)
      .values([{ code: `MATCH-${suffix}`, name: "Matching customer" }])
      .returning();
    const [store] = await db
      .insert(stores)
      .values({ customerId: customer.id, name: "Matching store" })
      .returning();

    const matchingDraft = await createDraft(customer.id, sameDayOlderDate);
    await createStoreGroup({
      customerId: customer.id,
      draftId: matchingDraft.id,
      storeId: store.id,
    });

    for (let index = 0; index < 51; index += 1) {
      const newerDraft = await createDraft(customer.id, sameDayNewerDate);
      await createStoreGroup({
        customerId: customer.id,
        draftId: newerDraft.id,
        status: "SUBMITTED",
        storeId: store.id,
      });
    }

    await expect(
      listAdminBulkDrafts({
        customerId: customer.id,
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        status: "EMPTY",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        diagnosticStatus: "EMPTY",
        id: matchingDraft.id,
      }),
    ]);
  });
});
